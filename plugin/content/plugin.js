var PaperNotePlugin = (() => {
  const PREF = 'extensions.paperNoteDeepSeek.';
  const PANE_ID = 'paper-note-deepseek-settings';
  const MENU_ID = 'paper-note-deepseek-generate';
  // 用子笔记标签识别插件生成的内容，保留用户手写的笔记。
  const NOTE_TAG = 'DeepSeek 论文阅读备注';
  const LOGIN_REALM = 'Zotero Paper Note DeepSeek API';
  const LOGIN_USER = 'api-key';
  const PDF_WAIT_MS = 35_000;
  const PDF_RETRY_MS = 60_000;
  const MAX_SOURCE_CHARS = 65_000;
  const PAPER_TYPES = new Set([
    'journalArticle', 'conferencePaper', 'preprint', 'thesis', 'report', 'manuscript',
  ]);

  const pending = new Map();
  const running = new Map();
  const requests = new Set();
  let observerID;
  let timer;
  let active = false;
  let processing = false;
  let lastAutoAlert = 0;

  function config() {
    return {
      baseURL: Zotero.Prefs.get(PREF + 'baseURL', true) || PaperNoteDeepSeek.DEFAULT_BASE_URL,
      model: Zotero.Prefs.get(PREF + 'model', true) || PaperNoteDeepSeek.DEFAULT_MODEL,
      automatic: Zotero.Prefs.get(PREF + 'automatic', true) === true,
      usePDF: Zotero.Prefs.get(PREF + 'usePDF', true) !== false,
    };
  }

  async function findLogin(baseURL) {
    // 登录管理器按 API 源保存密钥，切换域名或端口时使用对应凭据。
    const origin = new URL(PaperNoteDeepSeek.endpointFor(baseURL)).origin;
    const logins = await Services.logins.findLogins(origin, null, LOGIN_REALM);
    return logins.find(login => login.username === LOGIN_USER);
  }

  async function storeKey(baseURL, apiKey) {
    const origin = new URL(PaperNoteDeepSeek.endpointFor(baseURL)).origin;
    const login = Components.classes['@mozilla.org/login-manager/loginInfo;1']
      .createInstance(Components.interfaces.nsILoginInfo);
    login.init(origin, null, LOGIN_REALM, LOGIN_USER, apiKey, '', '');
    const previous = await findLogin(baseURL);
    if (previous) {
      await Services.logins.modifyLogin(previous, login);
    } else if (Services.logins.addLoginAsync) {
      await Services.logins.addLoginAsync(login);
    } else {
      Services.logins.addLogin(login);
    }
  }

  async function getSettings() {
    const options = config();
    // 设置页只需要知道当前地址是否已有密钥。
    return { ...options, hasKey: Boolean(await findLogin(options.baseURL)) };
  }

  function validOptions(input) {
    const baseURL = input.baseURL.trim() || PaperNoteDeepSeek.DEFAULT_BASE_URL;
    const model = input.model.trim() || PaperNoteDeepSeek.DEFAULT_MODEL;
    PaperNoteDeepSeek.endpointFor(baseURL);
    const apiKey = input.apiKey.trim();
    if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new Error('API 密钥包含无效字符。');
    }
    return { baseURL, model, apiKey, automatic: input.automatic, usePDF: input.usePDF };
  }

  async function saveSettings(input) {
    const options = validOptions(input);
    const previous = config();
    const login = await findLogin(options.baseURL);
    if (options.automatic && !options.apiKey && !login) {
      throw new Error('请填写当前 API 地址的密钥，再开启自动生成。');
    }
    if (options.apiKey) await storeKey(options.baseURL, options.apiKey);
    for (const name of ['baseURL', 'model', 'automatic', 'usePDF']) {
      Zotero.Prefs.set(PREF + name, options[name], true);
    }

    if (!options.automatic) {
      pending.clear();
    }
    if (options.apiKey || previous.baseURL !== options.baseURL ||
        previous.model !== options.model || previous.usePDF !== options.usePDF) {
      for (const request of running.values()) request.controller.abort();
    }
    schedule();
    return getSettings();
  }

  async function removeKey() {
    const options = config();
    const login = await findLogin(options.baseURL);
    if (login) await Services.logins.removeLogin(login);
    Zotero.Prefs.set(PREF + 'automatic', false, true);
    for (const request of requests) request.abort();
    pending.clear();
    schedule();
    return getSettings();
  }

  async function complete(options, messages, controller, timeoutMs) {
    const login = options.apiKey ? null : await findLogin(options.baseURL);
    const apiKey = options.apiKey || login?.password;
    if (!apiKey) throw new Error('请在 Zotero 设置的「论文阅读备注」中填写 API 密钥。');
    return PaperNoteDeepSeek.complete({
      baseURL: options.baseURL, model: options.model, apiKey, messages,
      signal: controller.signal, timeoutMs,
    });
  }

  async function testConnection(input) {
    const options = validOptions(input);
    const controller = newPaperNoteAbortController();
    requests.add(controller);
    try {
      // 用固定 JSON 样例测试认证和输出格式，避免发送论文资料。
      const result = await complete(options, [
        { role: 'system', content: 'Return a JSON object with exactly one field, ok, set to true.' },
        { role: 'user', content: 'Connection test. Respond with {"ok":true}.' },
      ], controller, 35_000);
      if (result.ok !== true) throw new Error('API 已连接，模型未按预期返回 JSON。');
    } finally {
      requests.delete(controller);
    }
  }

  function parentOf(item) {
    if (item?.isRegularItem() && !item.isFeedItem) return item;
    if (item?.isAttachment() && item.parentItemID) return Zotero.Items.get(item.parentItemID);
    return null;
  }

  function canWrite(item) {
    return Boolean(item?.isRegularItem() && !item.isFeedItem && !item.deleted && item.isEditable());
  }

  function isPaper(item) {
    if (PAPER_TYPES.has(item.itemType)) return true;
    const url = item.getField('url');
    return Boolean(item.getField('DOI') || (typeof url === 'string' &&
      /^https?:\/\/(?:www\.)?(?:arxiv\.org|biorxiv\.org|medrxiv\.org|openreview\.net)\//i.test(url)));
  }

  function existingNote(item) {
    return Zotero.Items.get(item.getNotes()).find(note => note.hasTag(NOTE_TAG));
  }

  function localDate() {
    const date = new Date();
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map(value => String(value).padStart(2, '0')).join('-');
  }

  async function extractPDF(item) {
    const attachments = await item.getBestAttachments();
    for (const attachment of attachments.filter(candidate => candidate.isPDFAttachment())) {
      try {
        if (!await attachment.getFilePathAsync()) continue;
        const result = await Zotero.PDFWorker.getFullText(attachment.id, 40, false);
        const extracted = result?.text?.trim() || '';
        if (extracted.replace(/\s/g, '').length < 200) continue;
        const truncated = extracted.length > MAX_SOURCE_CHARS ||
          (result.extractedPages > 0 && result.totalPages > result.extractedPages);
        const groupId = Zotero.Libraries.get(item.libraryID).libraryType === 'group'
          ? Zotero.Groups.getGroupIDFromLibraryID(item.libraryID)
          : undefined;
        return {
          key: attachment.key,
          groupId,
          url: attachment.getField('url'),
          text: extracted.slice(0, MAX_SOURCE_CHARS),
          truncated,
          pagesRead: result.extractedPages,
          totalPages: result.totalPages,
        };
      } catch {
        // 附件读取失败时继续尝试其他 PDF，最终可使用条目摘要。
      }
    }
    return null;
  }

  async function paperData(item, usePDF) {
    const extra = item.getField('extra');
    const readingId = extra.match(/^(?:阅读编号|论文编号)[：:][ \t]*([\w-]{1,20})[ \t]*$/m)?.[1];
    const readingStatus = item.hasTag('/unread') ? '未读（条目标签 /unread）'
      : item.hasTag('/read') ? '已读（条目标签 /read）' : '未标记';
    const venue = item.getField('publicationTitle', false, true) ||
      item.getField('proceedingsTitle') || item.getField('conferenceName') ||
      item.getField('repository') || item.getField('university');
    const abstract = item.getField('abstractNote').trim().slice(0, 12_000);
    return {
      title: item.getDisplayTitle(),
      shortTitle: item.getField('shortTitle'),
      readingId, readingStatus, venue, abstract,
      year: item.getField('year'),
      doi: item.getField('DOI'),
      url: item.getField('url'),
      date: localDate(),
      pdf: usePDF ? await extractPDF(item) : null,
    };
  }

  async function generate(item, controller) {
    if (!canWrite(item)) return 'unavailable';
    if (existingNote(item)) return 'exists';
    const options = config();
    const data = await paperData(item, options.usePDF);
    if (controller.signal.aborted) return 'cancelled';
    if (!data.abstract && !data.pdf?.text) return 'no-source';
    const result = await complete(options, PaperNoteTemplate.buildMessages(data), controller);
    const html = PaperNoteTemplate.renderNote(result, data);
    if (!active || controller.signal.aborted) return 'cancelled';
    // 网络请求期间条目和笔记可能有变动，保存前再核对权限和重复项。
    const current = await Zotero.Items.getAsync(item.id);
    if (!active || controller.signal.aborted) return 'cancelled';
    if (!canWrite(current)) return 'unavailable';
    if (existingNote(current)) return 'exists';

    const note = new Zotero.Item('note');
    note.libraryID = current.libraryID;
    note.parentKey = current.key;
    note.setNote(html);
    note.addTag(NOTE_TAG);
    await note.saveTx();
    return 'created';
  }

  function run(item) {
    // 自动和手动入口共用同一条目的在途任务。
    if (running.has(item.id)) return running.get(item.id).promise;
    const controller = newPaperNoteAbortController();
    requests.add(controller);
    const promise = generate(item, controller).finally(() => {
      running.delete(item.id);
      requests.delete(controller);
    });
    running.set(item.id, { controller, promise });
    return promise;
  }

  function notify(message, window = Zotero.getMainWindow()) {
    if (!window || window.closed) return;
    const popup = new Zotero.ProgressWindow({ window, closeOnClick: true });
    popup.changeHeadline('论文阅读备注');
    popup.addDescription(message);
    popup.show();
    popup.startCloseTimer(6_000);
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!active || processing || !pending.size) return;
    const due = Math.min(...Array.from(pending.values(), entry => entry.due));
    timer = setTimeout(processNext, Math.max(0, due - Date.now()));
  }

  async function processNext() {
    if (!active || !config().automatic || processing) return;
    const next = Array.from(pending).find(([, entry]) => entry.due <= Date.now());
    if (!next) {
      schedule();
      return;
    }
    const [id, entry] = next;
    pending.delete(id);
    processing = true;
    try {
      const item = await Zotero.Items.getAsync(id);
      if (!active || !config().automatic || !canWrite(item)) return;
      const status = await run(item);
      // 条目暂缺资料时，给稍后写入的摘要或附件留出时间。
      if (active && config().automatic && status === 'no-source' && entry.retries < 2) {
        pending.set(id, { due: Date.now() + PDF_RETRY_MS, retries: entry.retries + 1 });
      }
    } catch (error) {
      if (error.code !== 'cancelled' && Date.now() - lastAutoAlert > 60_000) {
        lastAutoAlert = Date.now();
        notify(error.message || '自动生成失败，可在条目右键菜单中重试。');
      }
    } finally {
      processing = false;
      schedule();
    }
  }

  function observe(event, type, ids, extraData) {
    if (!active || type !== 'item' || event !== 'add' ||
        extraData?.skipAutoSync || !config().automatic) return;
    for (const id of ids) {
      const item = Zotero.Items.get(id);
      if (!canWrite(item) || !isPaper(item) || pending.has(id) || running.has(id)) continue;
      // 条目先入库，PDF 可能仍在下载或导入。
      pending.set(id, { due: Date.now() + PDF_WAIT_MS, retries: 0 });
    }
    schedule();
  }

  async function manual(item, window) {
    if (!active || !canWrite(item)) return;
    pending.delete(item.id);
    schedule();
    const messages = {
      created: '阅读备注已添加到论文条目下。',
      exists: '这篇论文已有插件生成的阅读备注。',
      unavailable: '此条目当前无法添加阅读备注。',
      'no-source': '缺少可读的 PDF 正文或 Zotero 摘要。补齐资料后可重新生成。',
    };
    notify('正在生成阅读备注…', window);
    try {
      const status = await run(item);
      if (messages[status]) notify(messages[status], window);
    } catch (error) {
      if (error.code !== 'cancelled') notify(error.message || '生成失败，请重试。', window);
    }
  }

  function selectedPaper(window) {
    const selected = window.ZoteroPane?.getSelectedItems() || [];
    return selected.length === 1 ? parentOf(selected[0]) : null;
  }

  function addMenu(window) {
    const doc = window.document;
    const popup = doc.getElementById('zotero-itemmenu');
    if (!popup || doc.getElementById(MENU_ID)) return;
    const menu = doc.createXULElement('menuitem');
    menu.id = MENU_ID;
    menu.setAttribute('label', '生成论文阅读备注（DeepSeek）');
    const update = event => {
      if (event.target === popup) menu.hidden = !canWrite(selectedPaper(window));
    };
    menu.addEventListener('command', () => manual(selectedPaper(window), window));
    popup.addEventListener('popupshowing', update);
    menu.paperNoteMenuCleanup = () => popup.removeEventListener('popupshowing', update);
    popup.appendChild(menu);
  }

  function removeMenu(window) {
    const menu = window.document.getElementById(MENU_ID);
    menu?.paperNoteMenuCleanup?.();
    menu?.remove();
  }

  async function start(id) {
    await Zotero.PreferencePanes.register({
      pluginID: id,
      id: PANE_ID,
      label: '论文阅读备注',
      src: 'content/settings.xhtml',
      scripts: ['content/settings.js'],
      stylesheets: ['content/settings.css'],
    });
    Zotero.PaperNoteDeepSeekSettings = { getSettings, saveSettings, removeKey, testConnection };
    active = true;
    observerID = Zotero.Notifier.registerObserver({ notify: observe }, ['item'], 'paperNoteDeepSeek');
  }

  function stop() {
    active = false;
    clearTimeout(timer);
    pending.clear();
    for (const controller of requests) controller.abort();
    if (observerID) Zotero.Notifier.unregisterObserver(observerID);
    for (const window of Zotero.getMainWindows()) removeMenu(window);
    delete Zotero.PaperNoteDeepSeekSettings;
  }

  return { start, stop, addMenu, removeMenu };
})();

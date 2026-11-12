window.ZoteroPaperNotePreferences = {
  init(root, event) {
    if (root.paperNoteReady) return;
    root.paperNoteReady = true;
    const service = Zotero.PaperNoteDeepSeekSettings;
    const field = name => root.querySelector('#paper-note-deepseek-' + name);
    const url = field('url');
    const model = field('model');
    const key = field('key');
    const automatic = field('automatic');
    const pdf = field('pdf');
    const save = field('save');
    const test = field('test');
    const remove = field('remove');
    const status = field('status');
    const controls = [url, model, key, automatic, pdf, save, test, remove];
    let hasKey = false;

    function fill(settings) {
      url.value = settings.baseURL;
      model.value = settings.model;
      automatic.checked = settings.automatic;
      pdf.checked = settings.usePDF;
      key.value = '';
      key.placeholder = settings.hasKey ? '密钥已保存，留空继续使用' : '粘贴 API 密钥';
      hasKey = settings.hasKey;
    }

    function values() {
      return {
        baseURL: url.value,
        model: model.value,
        apiKey: key.value,
        automatic: automatic.checked,
        usePDF: pdf.checked,
      };
    }

    async function perform(action, success = '', waiting = '') {
      for (const control of controls) control.disabled = true;
      status.textContent = waiting;
      status.removeAttribute('data-error');
      try {
        await action();
        status.textContent = success;
      } catch (error) {
        status.textContent = error.message || '操作失败，请重试。';
        status.setAttribute('data-error', 'true');
      } finally {
        for (const control of controls) control.disabled = false;
        remove.disabled = !hasKey;
      }
    }

    save.addEventListener('click', () => perform(
      async () => fill(await service.saveSettings(values())), '设置已保存。',
    ));
    test.addEventListener('click', () => perform(
      () => service.testConnection(values()), '连接成功，模型已返回 JSON。', '正在测试连接…',
    ));
    remove.addEventListener('click', () => perform(
      async () => fill(await service.removeKey()), '已移除当前 API 地址的密钥，自动生成已关闭。',
    ));
    const ready = perform(async () => fill(await service.getSettings()));
    event?.waitUntil?.(ready);
  },
};

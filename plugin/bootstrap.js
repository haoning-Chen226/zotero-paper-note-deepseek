var PaperNoteDeepSeek;
var PaperNoteTemplate;
var PaperNotePlugin;

async function startup({ id, rootURI }) {
  const scope = this;
  // 从 Zotero 窗口取得 AbortController，供插件脚本取消网络请求。
  scope.newPaperNoteAbortController = () => {
    const window = Zotero.getMainWindow() || Services.wm.getMostRecentWindow(null);
    return new window.AbortController();
  };
  Services.scriptloader.loadSubScript(rootURI + 'content/deepseek.js', scope, 'UTF-8');
  Services.scriptloader.loadSubScript(rootURI + 'content/note.js', scope, 'UTF-8');
  Services.scriptloader.loadSubScript(rootURI + 'content/plugin.js', scope, 'UTF-8');
  await PaperNotePlugin.start(id);
  for (const window of Zotero.getMainWindows()) {
    PaperNotePlugin.addMenu(window);
  }
}

function onMainWindowLoad({ window }) {
  PaperNotePlugin?.addMenu(window);
}

function onMainWindowUnload({ window }) {
  PaperNotePlugin?.removeMenu(window);
}

function shutdown() {
  PaperNotePlugin?.stop();
}

function install() {}
function uninstall() {}

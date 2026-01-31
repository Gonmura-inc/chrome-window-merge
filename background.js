/**
 * Window Merge - Chrome Extension
 * 複数のChromeウィンドウを1つに統合する拡張機能
 */

// ============================================================
// 定数
// ============================================================

const COMMANDS = {
  MERGE_WINDOWS: 'merge-windows'
};

const TAB_POSITION = {
  START: 0,
  END: -1
};

// ============================================================
// PWAウィンドウ管理
// ============================================================

// PWAウィンドウIDを保持するSet
const pwaWindowIds = new Set();

/**
 * Content Scriptからのメッセージを受信
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'PWA_DETECTED' && sender.tab) {
    const windowId = sender.tab.windowId;
    pwaWindowIds.add(windowId);
  }
});

/**
 * ウィンドウが閉じられたらPWAリストから削除
 */
chrome.windows.onRemoved.addListener((windowId) => {
  pwaWindowIds.delete(windowId);
});

// ============================================================
// イベントリスナー
// ============================================================

chrome.action.onClicked.addListener(({ windowId }) => executeMerge(windowId));

chrome.commands.onCommand.addListener(async (command) => {
  if (command === COMMANDS.MERGE_WINDOWS) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) executeMerge(tab.windowId);
  }
});

// ============================================================
// メイン処理
// ============================================================

/**
 * マージ処理を実行
 * @param {number} targetWindowId - 統合先ウィンドウID
 */
async function executeMerge(targetWindowId) {
  try {
    const sourceWindows = await getSourceWindows(targetWindowId);

    for (const window of sourceWindows) {
      await migrateWindow(window.id, targetWindowId);
    }
  } catch (error) {
    console.error('Window merge failed:', error);
  }
}

/**
 * 統合元となるウィンドウ一覧を取得
 * PWAウィンドウは除外される
 * @param {number} targetWindowId - 統合先ウィンドウID
 * @returns {Promise<chrome.windows.Window[]>}
 */
async function getSourceWindows(targetWindowId) {
  const targetWindow = await chrome.windows.get(targetWindowId);
  const allWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });

  return allWindows.filter(w =>
    w.id !== targetWindowId &&
    w.incognito === targetWindow.incognito &&
    !pwaWindowIds.has(w.id)  // PWAウィンドウを除外
  );
}

/**
 * ウィンドウの全コンテンツを別ウィンドウに移行
 * @param {number} sourceWindowId - 移行元ウィンドウID
 * @param {number} targetWindowId - 移行先ウィンドウID
 */
async function migrateWindow(sourceWindowId, targetWindowId) {
  const tabs = await chrome.tabs.query({ windowId: sourceWindowId });
  if (tabs.length === 0) return;

  const { pinned, grouped, ungrouped } = await classifyTabs(tabs, sourceWindowId);

  await migratePinnedTabs(pinned, targetWindowId);
  await migrateTabGroups(grouped, targetWindowId);
  await migrateTabs(ungrouped.map(t => t.id), targetWindowId);
}

// ============================================================
// タブ分類
// ============================================================

/**
 * タブをピン留め/グループ/通常に分類
 * @param {chrome.tabs.Tab[]} tabs - タブ一覧
 * @param {number} windowId - ウィンドウID
 * @returns {Promise<{pinned: chrome.tabs.Tab[], grouped: GroupedTabs[], ungrouped: chrome.tabs.Tab[]}>}
 */
async function classifyTabs(tabs, windowId) {
  const pinned = tabs.filter(t => t.pinned);
  const unpinned = tabs.filter(t => !t.pinned);

  const groups = await chrome.tabGroups.query({ windowId });
  const groupedTabIds = new Set();

  const grouped = await Promise.all(
    groups.map(async (group) => {
      const groupTabs = await chrome.tabs.query({ windowId, groupId: group.id });
      groupTabs.forEach(t => groupedTabIds.add(t.id));
      return { group, tabs: groupTabs };
    })
  );

  const ungrouped = unpinned.filter(t => !groupedTabIds.has(t.id));

  return { pinned, grouped, ungrouped };
}

// ============================================================
// タブ移行処理
// ============================================================

/**
 * ピン留めタブを移行（ピン留め状態を保持）
 * @param {chrome.tabs.Tab[]} tabs - ピン留めタブ一覧
 * @param {number} targetWindowId - 移行先ウィンドウID
 */
async function migratePinnedTabs(tabs, targetWindowId) {
  for (const tab of tabs) {
    const moved = await safeMove(tab.id, targetWindowId, TAB_POSITION.START);
    if (moved) {
      await chrome.tabs.update(tab.id, { pinned: true }).catch(() => {});
    }
  }
}

/**
 * タブグループを移行（グループ情報を保持）
 * @param {GroupedTabs[]} groupedTabs - グループ化されたタブ情報
 * @param {number} targetWindowId - 移行先ウィンドウID
 */
async function migrateTabGroups(groupedTabs, targetWindowId) {
  for (const { group, tabs } of groupedTabs) {
    if (tabs.length === 0) continue;

    const moved = await safeMoveGroup(group.id, targetWindowId);
    if (!moved) {
      await recreateGroup(group, tabs, targetWindowId);
    }
  }
}

/**
 * 通常タブを移行
 * @param {number[]} tabIds - タブID一覧
 * @param {number} targetWindowId - 移行先ウィンドウID
 */
async function migrateTabs(tabIds, targetWindowId) {
  if (tabIds.length === 0) return;

  const moved = await safeMoveMultiple(tabIds, targetWindowId);
  if (!moved) {
    for (const tabId of tabIds) {
      await safeMove(tabId, targetWindowId);
    }
  }
}

/**
 * グループを再作成して移行（フォールバック）
 * @param {chrome.tabGroups.TabGroup} group - 元のグループ情報
 * @param {chrome.tabs.Tab[]} tabs - グループ内タブ
 * @param {number} targetWindowId - 移行先ウィンドウID
 */
async function recreateGroup(group, tabs, targetWindowId) {
  const tabIds = tabs.map(t => t.id);
  const moved = await safeMoveMultiple(tabIds, targetWindowId);
  if (!moved) return;

  try {
    const newGroupId = await chrome.tabs.group({
      tabIds,
      createProperties: { windowId: targetWindowId }
    });

    await chrome.tabGroups.update(newGroupId, {
      title: group.title,
      color: group.color,
      collapsed: group.collapsed
    });
  } catch (error) {
    console.error('Failed to recreate group:', error);
  }
}

// ============================================================
// 安全なタブ操作（エラーハンドリング付き）
// ============================================================

/**
 * 単一タブを安全に移動
 * @param {number} tabId - タブID
 * @param {number} windowId - 移動先ウィンドウID
 * @param {number} index - 配置位置（デフォルト: 末尾）
 * @returns {Promise<boolean>} 成功したかどうか
 */
async function safeMove(tabId, windowId, index = TAB_POSITION.END) {
  try {
    await chrome.tabs.move(tabId, { windowId, index });
    return true;
  } catch (error) {
    console.error(`Failed to move tab ${tabId}:`, error);
    return false;
  }
}

/**
 * 複数タブを安全に移動
 * @param {number[]} tabIds - タブID一覧
 * @param {number} windowId - 移動先ウィンドウID
 * @returns {Promise<boolean>} 成功したかどうか
 */
async function safeMoveMultiple(tabIds, windowId) {
  try {
    await chrome.tabs.move(tabIds, { windowId, index: TAB_POSITION.END });
    return true;
  } catch (error) {
    console.error('Failed to move tabs:', error);
    return false;
  }
}

/**
 * タブグループを安全に移動
 * @param {number} groupId - グループID
 * @param {number} windowId - 移動先ウィンドウID
 * @returns {Promise<boolean>} 成功したかどうか
 */
async function safeMoveGroup(groupId, windowId) {
  try {
    await chrome.tabGroups.move(groupId, { windowId, index: TAB_POSITION.END });
    return true;
  } catch (error) {
    console.error(`Failed to move group ${groupId}:`, error);
    return false;
  }
}

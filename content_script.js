/**
 * Content Script - PWA Detection
 * PWA（Progressive Web App）モードで実行されているかを検出し、
 * background.jsに通知する
 */

(function() {
  // PWAとして認識するdisplay-modeの一覧
  const PWA_DISPLAY_MODES = [
    'standalone',        // 標準的なPWAモード
    'minimal-ui',        // 最小限のUIを持つPWAモード
    'fullscreen',        // フルスクリーンモード
    'window-controls-overlay'  // ウィンドウコントロールオーバーレイモード
  ];

  /**
   * 現在のページがPWAモードで実行されているかをチェック
   * @returns {boolean} PWAモードならtrue
   */
  function isPWAMode() {
    return PWA_DISPLAY_MODES.some(mode =>
      window.matchMedia(`(display-mode: ${mode})`).matches
    );
  }

  /**
   * PWAモードであればbackground.jsに通知
   */
  function notifyPWAStatus() {
    if (isPWAMode()) {
      chrome.runtime.sendMessage({
        type: 'PWA_DETECTED',
        url: window.location.href
      }).catch(() => {
        // 拡張機能のコンテキストが無効な場合のエラーを無視
      });
    }
  }

  // ページ読み込み時にPWA判定を実行
  notifyPWAStatus();
})();

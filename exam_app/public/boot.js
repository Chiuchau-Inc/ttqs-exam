/* 啟動輔助：離開提醒 + 只在作答中顯示計時列。獨立外部檔以符合嚴格 CSP。 */
(function () {
  'use strict';
  // 作答中切換/關閉頁面前提醒
  window.addEventListener('beforeunload', function (e) {
    try {
      var raw = localStorage.getItem('ttqs_exam_state_v1');
      if (raw && !JSON.parse(raw).STATE.submitted) { e.preventDefault(); e.returnValue = ''; }
    } catch (x) {}
  });
  // 只有作答中才顯示計時列
  function syncTopbar() {
    var exam = document.getElementById('view-exam');
    var bar = document.getElementById('topbar');
    if (!exam || !bar) return;
    bar.style.display = exam.classList.contains('hidden') ? 'none' : 'flex';
  }
  function start() {
    var exam = document.getElementById('view-exam');
    if (exam) new MutationObserver(syncTopbar).observe(exam, { attributes: true, attributeFilter: ['class'] });
    syncTopbar();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

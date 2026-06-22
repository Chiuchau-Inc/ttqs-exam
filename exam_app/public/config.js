// 前端設定（不含任何機密）。Dify API key 放後端環境變數，前端永遠拿不到。
window.EXAM_CONFIG = {
  // 是否啟用 AI 評分簡答/申論題。實際是否可用以後端 /api/health 為準
  // （後端沒設 DIFY_API_KEY 時會自動退回「參考答案自評」模式）。
  enableAiGrading: true,
};

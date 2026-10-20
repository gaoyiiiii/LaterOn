(function () {
  const words = {
    models: ['模型', 'Models'], ai: ['AI 功能', 'AI features'], enable: ['启用 AI 功能', 'Enable AI features'],
    enableHint: ['让 AI 自动辅助整理新收藏的网页，不确定时保留在等待整理。', 'Let AI help organize newly saved pages automatically; uncertain matches stay in Inbox.'],
    modelLinkBefore: ['AI 辅助整理基于 ', 'AI-assisted organization uses the extraction and classification services configured in '],
    modelLinkAfter: [' 中的网页提取与归类配置。配置保存并启用后，快捷键与右键收藏的网页会自动归类；通过界面添加时仍可手动选择项目。', '. Once the configuration is saved and enabled, pages saved via keyboard shortcuts or the context menu are classified automatically. Pages added through the interface can still be assigned to a project manually.'],
    settingsActive: ['当前模型配置已完成，AI 辅助归类可用。', 'Model setup is complete and AI-assisted classification is available.'],
    settingsIncomplete: ['当前模型配置尚未完成，AI 辅助归类暂不可用；请前往模型完成配置并启用。', 'Model setup is incomplete, so AI-assisted classification is unavailable. Complete setup and enable it in Models.'],
    settingsIncompleteOff: ['当前模型配置尚未完成，AI 辅助归类暂不可用；请先开启 AI，再前往模型完成配置。', 'Model setup is incomplete and AI-assisted classification is unavailable. Turn on AI above, then complete setup in Models.'],
    settingsReady: ['当前模型渠道已就绪，但 AI 辅助归类尚未启用；请前往模型点击“保存并启用”。', 'Your model channels are ready, but AI-assisted classification is not active. Select Save and enable in Models.'],
    settingsOff: ['当前模型配置已保留，AI 辅助归类已关闭；如需使用，请开启上方开关。', 'Your model configuration is saved, but AI-assisted classification is off. Turn on the switch above to use it.'],
    settingsMissingNotes: ['AI 辅助归类暂不可用，请先补全以下项目的简介。', 'AI-assisted classification is unavailable. Complete the project descriptions below first.'],
    settingsNoProjects: ['AI 辅助归类暂不可用，请先创建项目并填写简介。', 'AI-assisted classification is unavailable. Create a project with a description first.'],
    settingsConfigured: ['当前模型配置已完成；', 'Model setup is complete. '],
    settingsUnconfigured: ['当前模型配置尚未完成；', 'Model setup is incomplete. '],
    setupIncomplete: ['模型配置尚未完成，自动归类暂未启用。', 'Model setup is incomplete. Automatic classification is not active yet.'],
    setupReady: ['渠道已就绪，等待启用自动归类。', 'Your channels are ready. Automatic classification still needs to be enabled.'],
    setupCreateProjects: ['请先在收藏库中新建项目并填写简介，AI 会依据简介将新收藏的网页归入这些项目。', 'Create projects with descriptions in the library first. AI uses those descriptions to classify new saves into your projects.'],
    extract: ['网页提取', 'Page extraction'], classify: ['归类判断', 'Classification'],
    local: ['浏览器本地提取', 'Browser extraction'], builtin: ['内置，无需 API', 'Built in · No API required'],
    add: ['添加渠道', 'Add channel'], test: ['测试连接', 'Test connection'], remove: ['删除', 'Delete'],
    name: ['渠道名称', 'Channel name'], provider: ['服务渠道', 'Provider'],
    endpoint: ['服务地址', 'Service URL'], actualEndpoint: ['请求地址', 'Request URL'], model: ['模型 ID', 'Model ID'],
    key: ['API Key', 'API key'], keyHint: ['已保存密钥；留空保持不变', 'Key saved; leave blank to keep it'], clearKey: ['清除密钥', 'Clear key'],
    protocol: ['接口协议', 'Protocol'], depth: ['提取深度', 'Extraction depth'], basic: ['标准', 'Basic'], advanced: ['高级', 'Advanced'],
    jsonMode: ['使用服务端 JSON 模式', 'Use server JSON mode'], score: ['最低候选分数', 'Minimum candidate score'], margin: ['最低候选分差', 'Minimum score margin'],
    scoreHint: ['Chat 自评分与决策概率均不代表已验证的准确率。分差比较包含“等待整理”。', 'Self-estimates and decision probabilities are not verified accuracy. Margin includes the manual-sorting option.'],
    saveChannel: ['保存渠道', 'Save channel'], save: ['保存并启用', 'Save and enable'], cancel: ['取消', 'Cancel'],
    tested: ['测试通过', 'Test passed'], testing: ['正在测试…', 'Testing…'], testRequired: ['请先测试当前配置', 'Test this configuration first'],
    saved: ['已保存', 'Saved'], active: ['AI 已启用', 'AI is active'], notConfigured: ['尚未启用 AI 能力', 'AI is not configured'],
    aiDisabled: ['AI 已关闭，请先在通用设置中启用。', 'AI is off. Enable it in Settings first.'],
    missingNotes: ['请先补全以下项目的简介', 'Complete these project descriptions first'], noProjects: ['请先创建项目并填写简介', 'Create a project with a description first'],
    settings: ['设置', 'Settings'], back: ['返回 LaterOn', 'Back to LaterOn'],
    fallback: ['远程提取失败时，改用浏览器提取', 'Use browser extraction if the remote service fails'],
    recent: ['最近分类记录', 'Recent classifications'], empty: ['还没有分类记录。收藏新网页后，可以在这里查看结果。', 'No classifications yet. Results will appear here when you save new pages.'], choose: ['请选择渠道', 'Choose a channel'],
    history: ['分类历史', 'Classification history'], viewHistory: ['查看全部记录', 'View all records'],
    organizationRules: ['网页会怎么整理', 'How pages are organized'],
    organizationHint: ['整理规则、数据发送范围与提取失败后的处理方式', 'Sorting rules, data sharing and what happens if extraction fails'],
    organizationScope: ['AI 只整理新收藏的网页，把它们放进已有项目，不会新建项目或改写网页摘要。', 'AI sorts new saves into existing projects. It does not create projects or rewrite page summaries.'],
    organizationFailure: ['每次都用你选好的组合。拿不准或请求失败时，网页留在“等待整理”，也不会自动换一个模型再试。', 'Each save uses your selected combination. Uncertain matches or failed requests leave the page in Inbox, without trying another model.'],
    organizationPrivacy: ['用浏览器提取不需要额外的 API，但提取到的内容仍会发给归类服务。远程提取服务只收到网址，归类服务会收到网页内容和项目简介。密钥只保存在本机，不会放进收藏备份。', 'Browser extraction needs no extra API, but the extracted content is still sent to the classification service. Remote extraction receives the URL; classification receives the page content and project descriptions. Keys stay on this device and are not included in collection backups.'],
    testHint: ['测试会请求真实服务，可能产生费用；只使用公开测试网页或虚构分类样例。', 'Tests call the service and may incur charges. They only use a public test page or synthetic classification data.'],
    queued: ['等待 AI 分类', 'Queued for AI'], extracting: ['提取网页中', 'Extracting page'], read: ['等待判断', 'Ready to classify'], classifying: ['AI 分类中', 'Classifying'], answered: ['正在应用结果', 'Applying result'],
    applied: ['AI 已归类', 'Sorted by AI'], unmatched: ['等待人工整理', 'Needs manual sorting'], failed: ['AI 处理失败', 'AI failed'], interrupted: ['AI 处理已中断', 'AI interrupted'],
    matched: ['匹配明确', 'Clear match'], lowScore: ['候选分数不足', 'Score below threshold'], lowMargin: ['候选过于接近', 'Candidates too close'],
    metadata: ['网页元数据', 'Page metadata'], metadataOnly: ['正文不可用，使用标题与描述', 'Body unavailable; using title and description'],
    fallbackFrom: ['已回退本地提取', 'Fell back to browser extraction'], truncated: ['正文已裁剪', 'Content trimmed'],
    llm_estimate: ['模型自评分', 'Model self-estimate'], decision_probability: ['决策概率', 'Decision probability'],
    invalidChannel: ['渠道配置无效', 'Invalid channel'], invalidEndpoint: ['请输入有效的 HTTP(S) 地址，不含查询参数或凭据', 'Enter a valid HTTP(S) URL without query parameters or credentials'],
    invalidThreshold: ['阈值必须在 0 到 1 之间', 'Thresholds must be between 0 and 1'], missingFields: ['请填写渠道名称、服务地址及模型 ID', 'Complete the channel name, service URL and model ID'],
    missingKey: ['请填写 API Key', 'API key required'], connectionFailed: ['连接失败，请检查地址、网络与权限', 'Connection failed; check URL, network and permissions'],
    timeout: ['服务响应超时', 'Request timed out'], cancelled: ['任务已取消', 'Task cancelled'], invalidJson: ['服务没有返回有效 JSON', 'Invalid JSON response'],
    invalidAnswer: ['分类输出格式不符合要求', 'Invalid classification response'], invalidScores: ['候选分数不完整或不合法', 'Missing or invalid candidate scores'],
    refused: ['模型拒绝判断', 'Model refused'], refusedOrTruncated: ['模型拒答或输出被截断', 'Response refused or truncated'], responseTooLarge: ['服务响应过大', 'Response too large'],
    inputTooLarge: ['项目定义超出请求预算', 'Project definitions exceed the input budget'], tooManyProjects: ['项目过多，最多支持 254 个未归档项目', 'At most 254 active projects are supported'],
    localOnlyUrl: ['此网址只支持本地提取', 'This URL requires browser extraction'], emptyContent: ['未提取到正文', 'No content extracted'], extractionFailed: ['网页提取失败', 'Extraction failed'],
    contextChanged: ['网页归属、项目规则或配置已变化，未应用旧结果', 'Assignment, project rules or configuration changed; stale result discarded'],
    forbidden: ['此操作仅允许在扩展页面执行', 'This action requires a trusted extension page'], internalError: ['操作失败，请重试', 'Operation failed; try again'],
    http_401: ['鉴权失败，请检查 API Key', 'Authentication failed; check your API key'], http_402: ['服务余额不足', 'Insufficient service balance'], http_403: ['服务拒绝访问或提取此网页', 'Service denied access or extraction'],
    http_404: ['接口、模型或网页不可用', 'Endpoint, model or page unavailable'], http_429: ['服务请求过于频繁', 'Service rate limit exceeded']
  };
  function t(key) {
    const value = words[key];
    return value ? value[document.documentElement.lang === 'en' ? 1 : 0] : /^http_\d+$/.test(key) ? `HTTP ${key.slice(5)}` : key;
  }
  function apply() { document.querySelectorAll('[data-ai]').forEach(el => { el.textContent = t(el.dataset.ai); }); }
  async function send(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(t(result?.error || 'internalError'));
    return result.data;
  }
  window.LaterOnAIUI = { t, apply, send };
  document.addEventListener('DOMContentLoaded', apply);
})();

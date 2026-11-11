const $ = (selector) => document.querySelector(selector);
const apiBase = document.body.dataset.apiBase ?? '';
const state = {
  catalog: null,
  limits: null,
  category: "all",
  selected: null,
  files: [],
  jobs: new Map(),
  busy: false,
};
const pendingSubmissions = JSON.parse(
  sessionStorage.getItem("tdocs-pending-submissions") ?? "{}",
);
let recorder = null;
let recordingStream = null;
let recordingUrl = null;
let recordingGeneration = 0;
const categorySymbols = {
  all: "▦",
  PDFtool: "▤",
  ai_assistant: "✧",
  job_hunting: "▣",
  Image_Processing: "▧",
  Useful_Tools: "⌘",
};
const executionLabels = {
  local: "本地处理",
  cloud: "腾讯文档",
  interactive: "原生编辑器",
  provider: "第三方插件",
};
const statusLabels = {
  preparing: "准备中",
  submitting: "正在提交",
  generating: "AI 正在生成",
  saving: "正在保存",
  rendering: "正在生成图片",
  running: "处理中",
  completed: "已完成",
  failed: "处理失败",
  needs_attention: "需要处理",
  user_action_required: "请继续操作",
};
const validationLabels = {
  passed: "已实测",
  native_entry_verified: "编辑器内继续",
  native_action_pending: "插件内继续",
  pending: "待完成实测",
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error?.message ?? "请求失败，请重试。");
    error.code = value.error?.code;
    error.status = response.status;
    throw error;
  }
  return value;
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  setTimeout(() => $("#toast").classList.add("hidden"), 3500);
}

function bytes(value) {
  if (value === null || value === undefined) return "大小限制待查询";
  if (value >= 1024 ** 3) return `${value / 1024 ** 3} GiB`;
  return `${Math.round(value / 1024 ** 2)} MiB`;
}

function limitFor(id) {
  return state.limits?.tools.find((tool) => tool.id === id);
}

function limitSummary(tool) {
  const limit = limitFor(tool.id);
  if (!limit) return "正在读取限制";
  if (limit.sharedLabel) return limit.sharedLabel;
  if (limit.maxDurationSeconds)
    return `单文件 ${limit.maxDurationSeconds / 3600} 小时 · ${bytes(limit.maxBytes)}`;
  if (limit.maxBytes)
    return `单文件 ${bytes(limit.maxBytes)}${limit.maxFiles ? ` · 最多 ${limit.maxFiles} 个` : ""}`;
  if (limit.local?.maxBytes) return `单文件 ${bytes(limit.local.maxBytes)}`;
  if (limit.currentPlanMaxBytes)
    return `单文件 ${bytes(limit.effectiveMaxBytes)} · ${limit.currentPlan}`;
  if (limit.tiers) return `普通 ${bytes(limit.tiers.basic)} · 会员分档`;
  if (tool.addonId) return "文件限制由插件服务商提供";
  if (tool.id.startsWith("ai_") || tool.id === "resume")
    return "按账号 AI 积分及工具规则使用";
  return "具体限制以腾讯文档响应为准";
}

function quotaSummary(tool) {
  const limit = limitFor(tool.id);
  if (limit?.unlimited)
    return tool.execution === "local" ? "无限量（本地）" : "无限量";
  if (
    limit?.accountRemaining !== null &&
    limit?.accountRemaining !== undefined
  ) {
    return limit.unit === "seconds"
      ? `剩余 ${(Number(limit.accountRemaining) / 60).toFixed(1)} 分钟`
      : `权益余量 ${limit.accountRemaining}`;
  }
  if (tool.addonId) return "插件内查看额度";
  return "服务未返回独立额度";
}

function renderCategories() {
  const categories = [
    { id: "all", title: "全部工具" },
    ...state.catalog.groups,
  ];
  $("#categories").replaceChildren(
    ...categories.map((category) => {
      const button = node(
        "button",
        `nav-item${state.category === category.id ? " active" : ""}`,
      );
      button.append(
        node("span", "nav-symbol", categorySymbols[category.id] ?? "▦"),
        node("span", "", category.title),
      );
      const count =
        category.id === "all"
          ? state.catalog.tools.length
          : state.catalog.tools.filter((tool) =>
              tool.categories.includes(category.id),
            ).length;
      button.append(node("span", "nav-count", count));
      button.addEventListener("click", () => {
        state.category = category.id;
        $("#tools-section").classList.remove("hidden");
        $("#jobs-section").classList.add("hidden");
        $("#jobs-nav").classList.remove("active");
        $("#section-title").textContent = category.title;
        $("#breadcrumb").textContent = `工作台 / ${category.title}`;
        renderCategories();
        renderTools();
      });
      return button;
    }),
  );
}

function renderTools() {
  const query = $("#search").value.trim().toLowerCase();
  const tools = state.catalog.tools.filter(
    (tool) =>
      (state.category === "all" || tool.categories.includes(state.category)) &&
      [tool.title, tool.titleEn, ...tool.aliases]
        .join(" ")
        .toLowerCase()
        .includes(query),
  );
  $("#result-count").textContent =
    `${tools.length} 项 · ${tools.filter((tool) => tool.validation === "passed").length} 项已实测`;
  $("#tools-grid").replaceChildren(
    ...tools.map((tool) => {
      const card = node("button", "tool-card");
      const top = node("div", "card-top");
      const kind = tool.categories.includes("PDFtool")
        ? "pdf"
        : tool.categories.includes("ai_assistant")
          ? "ai"
          : tool.categories.includes("Image_Processing")
            ? "image"
            : tool.categories.includes("job_hunting")
              ? "resume"
              : "";
      const short =
        kind === "pdf"
          ? "PDF"
          : kind === "ai"
            ? "AI"
            : kind === "image"
              ? "IMG"
              : kind === "resume"
                ? "CV"
                : tool.id === "av_to_text"
                  ? "AV"
                  : "DOC";
      top.append(
        node("span", `tool-icon ${kind}`, short),
        node("span", "card-arrow", "↗"),
      );
      const bottom = node("div", "card-bottom");
      const limit = limitFor(tool.id);
      bottom.append(
        node(
          "span",
          "execution",
          `${executionLabels[tool.execution]} · ${validationLabels[tool.validation] ?? "待完成实测"}`,
        ),
        node(
          "span",
          `quota-chip${limit?.accountRemaining != null ? " known" : ""}`,
          quotaSummary(tool),
        ),
      );
      card.append(
        top,
        node("h3", "", tool.title),
        node("p", "card-limit", limitSummary(tool)),
        bottom,
      );
      card.addEventListener("click", () => openTool(tool));
      return card;
    }),
  );
  $("#empty").classList.toggle("hidden", tools.length > 0);
}

function renderLimits() {
  const points = state.limits.points;
  $("#document-points").textContent = points?.documentRemaining ?? "未获取";
  $("#buddy-points").textContent = points?.buddyOneRemaining ?? "未获取";
  $("#pool-preference").textContent =
    points?.preferredPool === "document"
      ? "优先使用文档积分"
      : points?.preferredPool === "buddyOne"
        ? "优先使用通用积分"
        : "积分池偏好未获取";
  const audio = limitFor("av_to_text");
  $("#audio-quota").textContent =
    audio?.accountRemaining != null
      ? (Number(audio.accountRemaining) / 60).toFixed(1)
      : "未获取";
  $("#audio-total").textContent =
    audio?.accountTotal != null
      ? `总权益 ${Number(audio.accountTotal) / 60} 分钟`
      : "总时长未获取";
  $("#updated-at").textContent =
    `${new Date(state.limits.fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新`;
  $("#quota-error").textContent = state.limits.failures.length
    ? `${state.limits.failures.length} 项额度暂未获取`
    : "";
  renderTools();
}

function toggle(selector, show) {
  $(selector).classList.toggle("hidden", !show);
}

function openTool(tool) {
  if (state.busy) return;
  recordingGeneration++;
  stopRecording();
  $("#start-recording").disabled = false;
  $("#stop-recording").disabled = true;
  state.selected = tool;
  state.files = [];
  $("#tool-form").reset();
  $("#task-result").replaceChildren();
  $("#form-error").textContent = "";
  $("#dialog-title").textContent = tool.title;
  $("#dialog-category").textContent =
    state.catalog.groups.find((group) => group.id === tool.categories[0])
      ?.title ?? "实用工具";
  $("#dialog-limits").replaceChildren();
  const labels = [limitSummary(tool), quotaSummary(tool)];
  const limit = limitFor(tool.id);
  if (limit?.tiers)
    labels.push(
      `VIP ${bytes(limit.tiers.vip)}`,
      `超级会员 ${bytes(limit.tiers.svip)}`,
    );
  if (limit?.currentPlanMaxBytes)
    labels.push(`当前套餐 ${bytes(limit.currentPlanMaxBytes)}`);
  if (limit?.local?.note) labels.push(limit.local.note);
  if (limit?.maxPages === null) labels.push("页数限制未公开");
  for (const label of labels)
    $("#dialog-limits").append(node("span", "limit-tag", label));
  const needsFile = tool.input === "files";
  toggle("#file-field", needsFile);
  toggle(
    "#prompt-field",
    [
      "ai_create_ppt",
      "ai_create_mindmap",
      "ai_create_flowchart",
      "resume",
    ].includes(tool.id),
  );
  toggle("#markdown-field", tool.id === "markdown_to_mind");
  toggle("#url-field", tool.id === "web_clipper");
  toggle(
    "#pages-field",
    ["pdf_extract_page", "pdf_page_reflow", "file_to_image"].includes(tool.id),
  );
  toggle("#pdf-edit-fields", tool.id === "pdf_edit");
  toggle("#outline-field", tool.id === "outline_to_form");
  toggle("#translation-fields", tool.id === "translate");
  if (tool.id === "translate") {
    api("/v1/translation/languages")
      .then((data) => {
        if (state.selected?.id !== "translate") return;
        $("#source-language").replaceChildren(
          ...data.languages.map((language) => {
            const option = node("option", "", language.ch);
            option.value = language.en;
            return option;
          }),
        );
        $("#source-language").value = "en";
        const updateTargets = () => {
          const allowed = new Set(
            data.directions
              .filter(
                (direction) => direction.src === $("#source-language").value,
              )
              .map((direction) => direction.dst),
          );
          $("#target-language").replaceChildren(
            ...data.languages
              .filter((language) => allowed.has(language.en))
              .map((language) => {
                const option = node("option", "", language.ch);
                option.value = language.en;
                return option;
              }),
          );
        };
        $("#source-language").onchange = updateTargets;
        updateTargets();
      })
      .catch(() => {});
  }
  toggle("#audio-fields", ["av_to_text", "voice_notes"].includes(tool.id));
  toggle("#recording-field", tool.id === "voice_notes");
  $("#recording-status").textContent = "可录音或选择已有音频";
  toggle("#recording-preview", false);
  toggle(
    "#image-fields",
    ["image_compress", "image_stitching"].includes(tool.id),
  );
  toggle(
    "#native-notice",
    tool.execution === "interactive" || tool.execution === "provider",
  );
  $("#native-notice").textContent = tool.addonId
    ? "此工具由第三方插件提供，提交后会显示服务商信息和所需授权。"
    : tool.id === "voice_notes"
      ? "录音结束后提交转写，与音视频转文字共用账号时长。"
      : "处理后可在腾讯文档原生编辑器中继续确认参数。";
  $("#files").accept = tool.accept;
  $("#submit-tool").disabled = false;
  $("#submit-tool").firstChild.textContent = tool.addonId
    ? "查看插件入口 "
    : "开始处理 ";
  toggle("#tool-form", true);
  toggle("#task-result", false);
  renderSelectedFiles();
  $("#tool-dialog").showModal();
}

function renderSelectedFiles() {
  $("#selected-files").replaceChildren(
    ...state.files.map((file) => {
      const row = node("div", "file-row");
      row.append(
        node("span", "", file.name),
        node("span", "", `${(file.size / 1024 / 1024).toFixed(2)} MiB`),
      );
      return row;
    }),
  );
}

function safeLink(address, text, download = false) {
  let url;
  try {
    url = new URL(address.startsWith('/v1/') ? `${apiBase}${address}` : address, location.origin);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const anchor = node("a", "", text);
  anchor.href = url.href;
  if (!download) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  return anchor;
}

function renderJob(job, container) {
  const tool = state.catalog.tools.find((tool) => tool.id === job.toolId);
  const box = node("article", "job");
  const header = node("div", "job-header");
  header.append(
    node("span", "job-title", tool?.title ?? job.toolId),
    node("span", "job-time", new Date(job.createdAt).toLocaleString("zh-CN")),
  );
  box.append(
    header,
    node(
      "p",
      "job-status",
      `${statusLabels[job.state] ?? job.state}${job.state === "running" && Number.isFinite(job.progress) ? ` · ${job.progress}%` : ""}`,
    ),
  );
  if (job.error) box.append(node("p", "job-error", job.error.message));
  if (job.result?.message)
    box.append(node("p", "job-status", job.result.message));
  const links = node("div", "job-links");
  const addLink = (url, label, download) => {
    const link = safeLink(url, label, download);
    if (link) links.append(link);
  };
  if (job.result?.documentUrl)
    addLink(
      job.result.documentUrl,
      job.state === "user_action_required"
        ? "打开工具继续操作 ↗"
        : "打开结果文档 ↗",
    );
  if (job.result?.downloadUrl) addLink(job.result.downloadUrl, "下载文件 ↗");
  for (const download of job.result?.downloads ?? [])
    addLink(download.url, `↓ ${download.name ?? "下载文件"}`, true);
  if (job.result?.providerUrl) addLink(job.result.providerUrl, "服务商网站 ↗");
  for (const document of job.result?.documents ?? [])
    addLink(document.url, document.name || "打开结果文档 ↗");
  for (const artifact of job.result?.artifacts ?? [])
    addLink(`/v1/artifacts/${artifact.id}/content`, `↓ ${artifact.name}`, true);
  if (links.children.length) box.append(links);
  if (job.result?.text) box.append(node("pre", "job-text", job.result.text));
  if (
    [
      "running",
      "preparing",
      "submitting",
      "generating",
      "rendering",
      "saving",
    ].includes(job.state)
  ) {
    const progress = node("div", "progress");
    const bar = node("span");
    bar.style.width = `${Math.max(3, Math.min(100, job.progress ?? 10))}%`;
    progress.append(bar);
    box.append(progress);
  }
  if (container) container.replaceChildren(box);
  return box;
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  $("#job-count").textContent = jobs.length || "";
  $("#jobs-list").replaceChildren(
    ...(jobs.length
      ? jobs.map((job) => renderJob(job))
      : [node("div", "empty", "处理过的文件和任务会显示在这里。")]),
  );
  for (const pending of Object.values(pendingSubmissions)) {
    const item = node("article", "job");
    item.append(
      node(
        "p",
        "job-title",
        `${state.catalog.tools.find((tool) => tool.id === pending.toolId)?.title ?? pending.toolId} · 提交待确认`,
      ),
    );
    const button = node("button", "quiet", "核对并恢复原任务");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const job = await submitPending(pending);
        state.jobs.set(job.id, job);
        renderJobs();
        pollJob(job.id).catch((error) => toast(error.message));
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
    item.append(button);
    $("#jobs-list").prepend(item);
  }
}

async function submitPending(pending) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pending.requestId),
  );
  const id = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let existing;
  try {
    existing = await api(`/v1/jobs/${id}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const job =
    existing ??
    (await api(`/v1/tools/${pending.toolId}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": pending.requestId,
      },
      body: JSON.stringify(pending.input),
    }));
  delete pendingSubmissions[pending.toolId];
  sessionStorage.setItem(
    "tdocs-pending-submissions",
    JSON.stringify(pendingSubmissions),
  );
  return job;
}

async function refreshJobs() {
  const response = await api("/v1/jobs");
  for (const job of response.jobs) state.jobs.set(job.id, job);
  renderJobs();
}

async function pollJob(id) {
  while (true) {
    const job = await api(`/v1/jobs/${id}`);
    state.jobs.set(id, job);
    renderJobs();
    if ($("#tool-dialog").open && state.selected?.id === job.toolId)
      renderJob(job, $("#task-result"));
    if (
      [
        "completed",
        "failed",
        "needs_attention",
        "user_action_required",
      ].includes(job.state)
    ) {
      if (job.state === "completed")
        toast(
          `${state.catalog.tools.find((tool) => tool.id === job.toolId)?.title ?? "任务"}已完成`,
        );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
}

$("#tool-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const tool = state.selected;
  $("#form-error").textContent = "";
  state.busy = true;
  $("#submit-tool").disabled = true;
  try {
    if (pendingSubmissions[tool.id]) {
      const job = await submitPending(pendingSubmissions[tool.id]);
      state.jobs.set(job.id, job);
      toggle("#tool-form", false);
      toggle("#task-result", true);
      renderJob(job, $("#task-result"));
      renderJobs();
      pollJob(job.id).catch((error) => toast(error.message));
      return;
    }
    if (tool.input === "files" && !state.files.length)
      throw new Error("请选择要处理的文件。");
    const limit = limitFor(tool.id);
    if (limit?.maxFiles && state.files.length > limit.maxFiles)
      throw new Error(`此工具一次最多处理 ${limit.maxFiles} 个文件。`);
    const maxBytes =
      limit?.effectiveMaxBytes ?? limit?.maxBytes ?? limit?.local?.maxBytes;
    if (maxBytes && state.files.some((file) => file.size > maxBytes))
      throw new Error(`文件大小超过 ${bytes(maxBytes)}。`);
    let options = $("#options-json").value.trim()
      ? JSON.parse($("#options-json").value)
      : {};
    if (["av_to_text", "voice_notes"].includes(tool.id))
      Object.assign(options, {
        language: $("#language").value,
        speakerDiarization: $("#speakers").checked,
      });
    if (
      !$("#pages-field").classList.contains("hidden") &&
      $("#pages").value.trim()
    )
      options.pages = $("#pages").value.trim();
    if (!$("#prompt-field").classList.contains("hidden"))
      options.prompt = $("#prompt").value;
    if (tool.id === "markdown_to_mind") options.markdown = $("#markdown").value;
    if (tool.id === "web_clipper") options.url = $("#target-url").value;
    if (tool.id === "image_stitching")
      options.direction = $("#direction").value;
    if (tool.id === "image_compress")
      options.quality = Number($("#quality").value);
    if (tool.id === "pdf_edit" && !options.edits)
      options.edits = [
        {
          type: "text",
          text: $("#pdf-text").value,
          page: Number($("#pdf-page").value),
          x: Number($("#pdf-x").value),
          y: Number($("#pdf-y").value),
        },
      ];
    if (tool.id === "outline_to_form" && !options.questions)
      options.outline = $("#outline").value;
    if (tool.id === "translate")
      Object.assign(options, {
        sourceLanguage: $("#source-language").value,
        targetLanguage: $("#target-language").value,
      });
    $("#submit-note").textContent = state.files.length
      ? "正在上传文件…"
      : "正在提交…";
    const artifacts = [];
    for (const file of state.files)
      artifacts.push(
        (
          await api(`/v1/artifacts?filename=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
            body: file,
          })
        ).id,
      );
    const pending = {
      toolId: tool.id,
      requestId: crypto.randomUUID(),
      input: { artifacts, options },
    };
    pendingSubmissions[tool.id] = pending;
    sessionStorage.setItem(
      "tdocs-pending-submissions",
      JSON.stringify(pendingSubmissions),
    );
    const job = await submitPending(pending);
    state.jobs.set(job.id, job);
    toggle("#tool-form", false);
    toggle("#task-result", true);
    renderJob(job, $("#task-result"));
    renderJobs();
    pollJob(job.id).catch((error) => {
      $("#task-result").append(node("p", "job-error", error.message));
    });
  } catch (error) {
    $("#form-error").textContent =
      error instanceof SyntaxError
        ? "更多参数中的 JSON 格式不正确。"
        : `${error.message}${pendingSubmissions[tool.id] ? " 原提交已保留，再次点击将核对原任务。" : ""}`;
    renderJobs();
  } finally {
    state.busy = false;
    $("#submit-tool").disabled = false;
    $("#submit-note").textContent = "提交后可继续使用其他工具";
  }
});

$("#files").addEventListener("change", (event) => {
  state.files = [...event.target.files];
  renderSelectedFiles();
});
$("#dropzone").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("#dropzone").classList.add("dragging");
});
$("#dropzone").addEventListener("dragleave", () =>
  $("#dropzone").classList.remove("dragging"),
);
$("#dropzone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("#dropzone").classList.remove("dragging");
  state.files = [...event.dataTransfer.files];
  renderSelectedFiles();
});
$("#close-tool").addEventListener("click", () => {
  if (!state.busy) {
    recordingGeneration++;
    stopRecording();
    $("#tool-dialog").close();
  }
});
$("#tool-dialog").addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
  else {
    recordingGeneration++;
    stopRecording();
  }
});

function stopRecording() {
  if (recorder?.state === "recording") recorder.stop();
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
}

$("#start-recording").addEventListener("click", async () => {
  $("#form-error").textContent = "";
  const generation = recordingGeneration;
  $("#start-recording").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw new Error("当前浏览器不支持录音，请选择已有音频文件。");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    if (
      generation !== recordingGeneration ||
      !$("#tool-dialog").open ||
      state.selected?.id !== "voice_notes"
    ) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    recordingStream = stream;
    recorder = new MediaRecorder(recordingStream);
    const currentRecorder = recorder;
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      if (
        generation !== recordingGeneration ||
        !$("#tool-dialog").open ||
        state.selected?.id !== "voice_notes"
      )
        return;
      const type = currentRecorder.mimeType || "audio/webm";
      const file = new File(
        chunks,
        `语音速记-${new Date().toISOString().replace(/[:.]/g, "-")}.${type.includes("mp4") ? "m4a" : "webm"}`,
        { type },
      );
      state.files = [file];
      renderSelectedFiles();
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      recordingUrl = URL.createObjectURL(file);
      $("#recording-preview").src = recordingUrl;
      toggle("#recording-preview", true);
      $("#recording-status").textContent = "录音已保存到本次输入，可提交转写";
      $("#start-recording").disabled = false;
      $("#stop-recording").disabled = true;
      $("#submit-tool").disabled = false;
    });
    recorder.start(1000);
    $("#recording-status").textContent = "正在录音，停止后可试听并转写";
    $("#start-recording").disabled = true;
    $("#stop-recording").disabled = false;
    $("#submit-tool").disabled = true;
  } catch (error) {
    if (generation !== recordingGeneration) return;
    stopRecording();
    $("#start-recording").disabled = false;
    $("#form-error").textContent =
      error.name === "NotAllowedError"
        ? "麦克风权限未开启，可在浏览器允许录音，或选择音频文件。"
        : error.message;
  }
});
$("#stop-recording").addEventListener("click", stopRecording);
$("#search").addEventListener("input", () => state.catalog && renderTools());
$("#refresh").addEventListener("click", async () => {
  $("#refresh").disabled = true;
  try {
    state.limits = await api("/v1/limits/refresh", { method: "POST" });
    renderLimits();
    toast("额度已刷新");
  } catch (error) {
    toast(error.message);
  } finally {
    $("#refresh").disabled = false;
  }
});
$("#jobs-nav").addEventListener("click", () => {
  toggle("#tools-section", false);
  toggle("#jobs-section", true);
  $("#jobs-nav").classList.add("active");
  $("#breadcrumb").textContent = "工作台 / 任务记录";
  refreshJobs().catch((error) => toast(error.message));
});
$("#reload-jobs").addEventListener("click", () =>
  refreshJobs().catch((error) => toast(error.message)),
);

async function initialize() {
  try {
    if (location.hash.startsWith("#connect="))
      history.replaceState(null, "", location.pathname);
    const [health, catalog] = await Promise.all([
      api("/health"),
      api("/v1/tools"),
    ]);
    state.catalog = catalog;
    $("#tool-total").textContent = catalog.tools.length;
    $("#version").textContent = `v${health.version}`;
    $("#connection-state").textContent = "本机已连接";
    $(".connection-dot").style.background = "#0e7868";
    $("#footer-status").textContent = "已连接 127.0.0.1";
    renderCategories();
    renderTools();
    await Promise.all([
      api("/v1/limits").then((result) => {
        state.limits = result;
        renderLimits();
      }),
      refreshJobs(),
    ]);
    for (const job of state.jobs.values())
      if (job.state === "running") pollJob(job.id).catch(() => {});
  } catch (error) {
    $("#connection-state").textContent = "等待连接";
    $("#footer-status").textContent = error.message;
    toast(error.message);
  }
}

initialize();

// The embedding application supplies only theme colors, never account material.
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'tdocs-toolbox-theme') return;
  const allowed = new Set(['--ink','--muted','--paper','--line','--accent','--accent-light','--white']);
  for (const [key, value] of Object.entries(event.data.colors ?? {})) {
    if (allowed.has(key) && typeof value === 'string' && value.length < 256 && CSS.supports('color', value)) document.documentElement.style.setProperty(key,value);
  }
  if (['light','dark'].includes(event.data.colorScheme)) document.documentElement.style.colorScheme = event.data.colorScheme;
});

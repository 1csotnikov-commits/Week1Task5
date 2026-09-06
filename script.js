'use strict';

/* ============================================================
 * Конфигурация моделей и тарифов
 * ============================================================ */

// Тарифы — USD за 1 000 000 (1M) токенов.
//
// DeepSeek (актуально, источник: https://api-docs.deepseek.com/quick_start/pricing/):
//   - цены различаются для пиковых и внепиковых часов (внепиковые в 2 раза дешевле);
//   - входные токены делятся на "кэш-попадание" (cache hit) и "кэш-промах" (cache miss).
//   Пиковые часы: 01:00–04:00 и 06:00–10:00 UTC в будни; всё остальное — внепиковые.
//
// Groq (allam-2-7b): бесплатная модель — в списке моделей Groq API у неё нет поля pricing.
//   Модель llama-3.3-70b-versatile удалена из девелоперского (бесплатного) тарифа,
//   поэтому выбрана доступная бесплатная текстовая модель.
const MODELS = [
  {
    key: 'deepseek-flash',
    name: 'DeepSeek V4 Flash',
    model: 'deepseek-v4-flash',
    endpoint: 'https://api.deepseek.com/chat/completions',
    pricing: {
      type: 'deepseek',
      inputCacheMiss: { offPeak: 0.22, peak: 0.44 },
      inputCacheHit:  { offPeak: 0.007, peak: 0.014 },
      output:         { offPeak: 0.66, peak: 1.32 }
    }
  },
  {
    key: 'deepseek-pro',
    name: 'DeepSeek V4 Pro',
    model: 'deepseek-v4-pro',
    endpoint: 'https://api.deepseek.com/chat/completions',
    pricing: {
      type: 'deepseek',
      inputCacheMiss: { offPeak: 0.66, peak: 1.32 },
      inputCacheHit:  { offPeak: 0.022, peak: 0.044 },
      output:         { offPeak: 1.98, peak: 3.96 }
    }
  },
  {
    key: 'groq-allam',
    name: 'Groq ALLaM-2 7B',
    model: 'allam-2-7b',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    pricing: {
      type: 'flat',
      input: 0,
      output: 0
    }
  }
];

/* ============================================================
 * DOM-элементы
 * ============================================================ */
const form = document.getElementById('form');
const promptInput = document.getElementById('prompt');
const submitButton = document.getElementById('submit');
const spinner = document.getElementById('spinner');
const loadingText = document.getElementById('loading-text');
const globalError = document.getElementById('global-error');
const keyInputsWrap = document.getElementById('key-inputs');
const resultsWrap = document.getElementById('results');

/* ============================================================
 * Построение интерфейса: поля для ключей и карточки результатов
 * ============================================================ */
function buildUI() {
  for (const model of MODELS) {
    const field = document.createElement('div');
    field.className = 'key-field';

    const label = document.createElement('label');
    label.setAttribute('for', model.key + '-key');
    label.textContent = model.name;

    const input = document.createElement('input');
    input.type = 'password';
    input.id = model.key + '-key';
    input.placeholder = 'Введите API-ключ';
    input.autocomplete = 'off';
    input.spellcheck = false;

    field.append(label, input);
    keyInputsWrap.appendChild(field);

    const card = document.createElement('section');
    card.className = 'result-card';
    card.id = model.key + '-card';
    card.innerHTML =
      '<header class="card-header">' +
        '<h2>' + escapeHtml(model.name) + '</h2>' +
        '<span class="model-id">' + escapeHtml(model.model) + '</span>' +
      '</header>' +
      '<div class="result-meta"></div>' +
      '<div class="result-body"><p class="placeholder">Ожидание запроса…</p></div>';
    resultsWrap.appendChild(card);
  }
}

/* ============================================================
 * Утилиты
 * ============================================================ */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(2) + ' сек';
}

function formatCost(usd) {
  if (!Number.isFinite(usd)) return '—';
  if (usd > 0 && usd < 0.0001) return '$' + usd.toFixed(6);
  return '$' + usd.toFixed(4);
}

// Пиковые часы DeepSeek: будни, 01:00–04:00 и 06:00–10:00 UTC.
function isPeakHour(date) {
  date = date || new Date();
  const day = date.getUTCDay(); // 0 (вс) … 6 (сб)
  if (day === 0 || day === 6) return false;
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/* ============================================================
 * Расчёт стоимости по формуле:
 * (input_tokens * price_input + output_tokens * price_output) / 1_000_000
 * ============================================================ */
function computeCost(model, usage, peak) {
  const p = model.pricing;
  let inputCost = 0;
  let outputCost = 0;

  if (p.type === 'flat') {
    inputCost = (usage.prompt_tokens || 0) * p.input;
    outputCost = (usage.completion_tokens || 0) * p.output;
  } else {
    const tier = peak ? 'peak' : 'offPeak';
    const miss = (usage.prompt_cache_miss_tokens !== undefined && usage.prompt_cache_miss_tokens !== null)
      ? usage.prompt_cache_miss_tokens
      : (usage.prompt_tokens || 0);
    const hit = usage.prompt_cache_hit_tokens || 0;
    inputCost = miss * p.inputCacheMiss[tier] + hit * p.inputCacheHit[tier];
    outputCost = (usage.completion_tokens || 0) * p.output[tier];
  }

  return (inputCost + outputCost) / 1000000;
}

/* ============================================================
 * Человекочитаемые сообщения об ошибках
 * ============================================================ */
function humanizeError(status, message) {
  if (status === 401) return 'Неверный API-ключ (401).';
  if (status === 403) return 'Доступ запрещён (403). Проверьте ключ и права доступа.';
  if (status === 404) return 'Модель не найдена (404).';
  if (status === 429) return 'Превышен лимит запросов (429). Попробуйте позже.';
  if (status >= 500) return 'Ошибка сервера (' + status + ').';
  return 'Ошибка ' + status + (message ? ': ' + message : '.');
}

/* ============================================================
 * Запрос к одной модели.
 * Функция никогда не отклоняется — всегда возвращает объект результата,
 * поэтому ошибка одной модели не влияет на остальные.
 * ============================================================ */
async function callModel(model, prompt, apiKey) {
  const started = performance.now();
  try {
    const response = await fetch(model.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });

    let data = null;
    try {
      data = await response.json();
    } catch (e) {
      data = null;
    }

    const elapsedMs = performance.now() - started;

    if (!response.ok) {
      const message = data && data.error ? (data.error.message || data.error) : null;
      return { success: false, elapsedMs: elapsedMs, error: humanizeError(response.status, message) };
    }

    const usage = (data && data.usage) || {};
    const choice = data && data.choices && data.choices[0];
    const content = (choice && choice.message && choice.message.content) || '';

    return {
      success: true,
      elapsedMs: elapsedMs,
      content: content,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      cost: computeCost(model, usage, isPeakHour())
    };
  } catch (err) {
    return {
      success: false,
      elapsedMs: performance.now() - started,
      error: 'Сетевая ошибка: ' + (err && err.message ? err.message : 'не удалось выполнить запрос')
    };
  }
}

/* ============================================================
 * Отображение результата в карточке модели
 * ============================================================ */
function metric(label, value) {
  return '<div class="metric"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>';
}

function renderResult(model, result) {
  const card = document.getElementById(model.key + '-card');
  const meta = card.querySelector('.result-meta');
  const body = card.querySelector('.result-body');

  if (!result.success) {
    meta.innerHTML = '<span class="status error">Ошибка</span>';
    body.innerHTML = '<div class="error-msg">' + escapeHtml(result.error) + '</div>';
    return;
  }

  meta.innerHTML =
    '<span class="status ok">Готово</span>' +
    '<div class="metrics">' +
      metric('Время', formatSeconds(result.elapsedMs)) +
      metric('Входные токены', String(result.inputTokens)) +
      metric('Выходные токены', String(result.outputTokens)) +
      metric('Всего токенов', String(result.totalTokens)) +
      '<div class="metric cost"><span>Стоимость</span><b>' + formatCost(result.cost) + '</b></div>' +
    '</div>';

  const text = result.content ? escapeHtml(result.content) : '<em>(пустой ответ)</em>';
  body.innerHTML = '<div class="answer">' + text + '</div>';
}

/* ============================================================
 * Глобальные сообщения и индикатор загрузки
 * ============================================================ */
function showGlobalError(message) {
  globalError.textContent = message;
  globalError.hidden = false;
}

function clearGlobalError() {
  globalError.textContent = '';
  globalError.hidden = true;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  spinner.hidden = !loading;
  loadingText.hidden = !loading;
}

/* ============================================================
 * Обработчик отправки формы
 * ============================================================ */
form.addEventListener('submit', async function (event) {
  event.preventDefault();
  clearGlobalError();

  const prompt = promptInput.value.trim();
  if (!prompt) {
    showGlobalError('Введите текст запроса.');
    promptInput.focus();
    return;
  }

  // Запускаем все три запроса параллельно через Promise.all.
  // Каждый callModel сам перехватывает ошибки и возвращает результат,
  // поэтому один упавший запрос не помешает остальным.
  const tasks = MODELS.map(function (model) {
    const input = document.getElementById(model.key + '-key');
    const apiKey = input.value.trim();
    if (!apiKey) {
      return Promise.resolve({ success: false, elapsedMs: 0, error: 'API-ключ не указан.' });
    }
    return callModel(model, prompt, apiKey);
  });

  setLoading(true);
  try {
    const results = await Promise.all(tasks);
    results.forEach(function (result, index) {
      renderResult(MODELS[index], result);
    });
  } finally {
    setLoading(false);
  }
});

/* ============================================================
 * Инициализация
 * ============================================================ */
buildUI();


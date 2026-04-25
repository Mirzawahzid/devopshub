// Key names to surface as top-level summary cards (case-insensitive match)
const SUMMARY_KEYS = ['calories', 'protein', 'carbohydrates', 'fat', 'fiber', 'sugar', 'sodium'];

async function analyzeMeal() {
  const input = document.getElementById('mealInput').value.trim();
  const btn = document.getElementById('analyzeBtn');
  const btnText = document.getElementById('btnText');
  const btnSpinner = document.getElementById('btnSpinner');
  const errorBox = document.getElementById('errorBox');
  const resultsSection = document.getElementById('resultsSection');

  // Reset state
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
  resultsSection.classList.add('hidden');

  if (!input) {
    showError('Please describe your meal before analyzing.');
    return;
  }

  // Loading state
  btn.disabled = true;
  btnText.textContent = 'Analyzing…';
  btnSpinner.classList.remove('hidden');

  try {
    const res = await fetch('/api/nutritional-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || `Error ${res.status}: Something went wrong.`);
      return;
    }

    renderResults(data);
  } catch (err) {
    showError('Network error — could not reach the server. Please try again.');
    console.error(err);
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Analyze Nutritional Facts';
    btnSpinner.classList.add('hidden');
  }
}

function renderResults(data) {
  const resultsSection = document.getElementById('resultsSection');
  const summaryCards = document.getElementById('summaryCards');
  const detailedResults = document.getElementById('detailedResults');
  const rawJson = document.getElementById('rawJson');

  summaryCards.innerHTML = '';
  detailedResults.innerHTML = '';
  rawJson.textContent = JSON.stringify(data, null, 2);

  // Flatten the response: try common shapes returned by the API
  const nutrients = flattenNutrients(data);

  if (nutrients.length === 0) {
    detailedResults.innerHTML = '<p style="color:#718096;font-size:0.9rem;">No structured nutrient data found in response.</p>';
    resultsSection.classList.remove('hidden');
    return;
  }

  // ── Summary cards for key macros ──
  const summaryItems = nutrients.filter(n =>
    SUMMARY_KEYS.some(k => n.name.toLowerCase().includes(k))
  );

  summaryItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-value">${formatValue(item.amount)}</div>
      <div class="card-unit">${item.unit || ''}</div>
      <div class="card-label">${capitalize(item.name)}</div>
    `;
    summaryCards.appendChild(card);
  });

  // ── Full nutrient table ──
  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr><th>Nutrient</th><th>Amount</th><th>Unit</th></tr></thead>
  `;
  const tbody = document.createElement('tbody');

  nutrients.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${capitalize(item.name)}</td>
      <td>${formatValue(item.amount)}</td>
      <td>${item.unit || '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  detailedResults.appendChild(table);
  resultsSection.classList.remove('hidden');
}

/**
 * Attempts to extract a flat array of { name, amount, unit } from various
 * response shapes the API might return.
 */
function flattenNutrients(data) {
  const results = [];

  // Shape 1: data is an object of key → { amount, unit } or key → number
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // Check for a nested "nutrients" or "nutritionalInfo" key first
    const inner = data.nutrients || data.nutritionalInfo || data.nutrition || data.data || data;

    if (Array.isArray(inner)) {
      inner.forEach(item => {
        if (item.name !== undefined) {
          results.push({ name: item.name, amount: item.amount ?? item.value, unit: item.unit || '' });
        }
      });
    } else if (typeof inner === 'object') {
      Object.entries(inner).forEach(([key, val]) => {
        if (typeof val === 'number') {
          results.push({ name: key, amount: val, unit: '' });
        } else if (val && typeof val === 'object' && (val.amount !== undefined || val.value !== undefined)) {
          results.push({ name: key, amount: val.amount ?? val.value, unit: val.unit || val.unitName || '' });
        }
      });
    }
  }

  // Shape 2: data is directly an array
  if (Array.isArray(data)) {
    data.forEach(item => {
      if (item.name !== undefined) {
        results.push({ name: item.name, amount: item.amount ?? item.value, unit: item.unit || '' });
      }
    });
  }

  return results;
}

function formatValue(val) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return Number.isInteger(n) ? n : n.toFixed(2);
}

function capitalize(str) {
  if (!str) return '';
  return str.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

function showError(msg) {
  const errorBox = document.getElementById('errorBox');
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

// Allow Enter key to trigger analysis (Shift+Enter for new line)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('mealInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      analyzeMeal();
    }
  });
});

// Admin views for `imap-mcp-server serve`: agent tokens and the audit log.
// Only active when /api/tools/catalog answers — plain imap-setup has no such
// API and stays unchanged. Everything here is built with createElement and
// textContent: token names and audit details (folder names, tool arguments)
// come from agents and are untrusted text.

let catalog = null;
let tokens = [];
let editingTokenId = null;
let auditBefore = null;

const AUDIT_PAGE = 50;
const WIZARD_VIEWS = ['stepIndicator', 'providerSelection', 'credentialsForm', 'testConnection', 'accountsList'];

// Pill colors per tool group, riskier groups warmer.
const GROUP_STYLES = {
    read: 'bg-green-100 text-green-800',
    mark_read: 'bg-yellow-100 text-yellow-800',
    flag: 'bg-yellow-100 text-yellow-800',
    organize: 'bg-blue-100 text-blue-800',
    draft: 'bg-indigo-100 text-indigo-800',
    send: 'bg-red-100 text-red-800',
    delete: 'bg-red-100 text-red-800',
    spam_lists: 'bg-gray-100 text-gray-800'
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/api/tools/catalog');
        if (!response.ok) return;
        catalog = await response.json();
    } catch (error) {
        return;
    }

    document.getElementById('tokensNav').classList.remove('hidden');
    document.getElementById('auditNav').classList.remove('hidden');
    document.getElementById('tokensNav').addEventListener('click', viewTokens);
    document.getElementById('auditNav').addEventListener('click', viewAudit);
    document.getElementById('newTokenButton').addEventListener('click', () => showTokenForm(null));
    document.getElementById('tokenFormCancel').addEventListener('click', viewTokens);
    document.getElementById('tokenFormSave').addEventListener('click', saveToken);
    document.getElementById('tokenCreatedDone').addEventListener('click', viewTokens);
    document.getElementById('auditApply').addEventListener('click', () => loadAudit(true));
    document.getElementById('auditMore').addEventListener('click', () => loadAudit(false));
    document.querySelectorAll('[data-copy]').forEach(button => {
        button.addEventListener('click', () => copyText(document.getElementById(button.dataset.copy)));
    });

    renderToolChoices();
});

// Build an element: el('td', { className: 'py-3' }, 'text', childNode, …).
// Strings are appended as text nodes, never parsed as markup.
function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (name === 'className') node.className = value;
        else node.setAttribute(name, value);
    }
    node.append(...children.filter(child => child !== null && child !== undefined));
    return node;
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
}

function showAdminView(id) {
    WIZARD_VIEWS.forEach(view => document.getElementById(view).classList.add('hidden'));
    document.getElementById('adminViews').classList.remove('hidden');
    document.querySelectorAll('.admin-view').forEach(view => view.classList.toggle('hidden', view.id !== id));
}

const groupOf = name => catalog.tools.find(tool => tool.name === name)?.group;
const formatDate = iso => (iso ? new Date(iso).toLocaleString() : '—');

function pill(text, style) {
    return el('span', { className: `px-2 py-1 text-xs rounded-full ${style}` }, text);
}

// Token list
async function viewTokens() {
    showAdminView('tokensView');
    const table = document.getElementById('tokensTable');
    try {
        tokens = await api('/api/tokens');
    } catch (error) {
        table.replaceChildren(el('p', { className: 'text-red-800' }, error.message));
        return;
    }
    if (tokens.length === 0) {
        table.replaceChildren(el('p', { className: 'text-gray-500 text-center py-8' }, 'No agent tokens yet.'));
        return;
    }

    const header = el('tr', { className: 'border-b' },
        ...['Name', 'Tools', 'Created', 'Last used', 'Status'].map(title => el('th', { className: 'text-left pb-2' }, title)),
        el('th', { className: 'text-right pb-2' }, 'Actions'));
    const rows = tokens.map(token => {
        const counts = {};
        token.tools.forEach(name => {
            const group = groupOf(name);
            if (group) counts[group] = (counts[group] || 0) + 1;
        });
        const groupPills = Object.keys(GROUP_STYLES)
            .filter(group => counts[group])
            .map(group => pill(`${group} ${counts[group]}`, GROUP_STYLES[group]));
        const lastUsed = token.lastUsedAt
            ? `${formatDate(token.lastUsedAt)}${token.lastUsedFrom ? ` (${token.lastUsedFrom})` : ''}`
            : 'never';
        const status = token.revokedAt
            ? pill('Revoked', 'bg-red-100 text-red-800')
            : pill('Active', 'bg-green-100 text-green-800');

        const actions = el('td', { className: 'py-3 text-right whitespace-nowrap' });
        if (!token.revokedAt) {
            const edit = el('button', { className: 'text-blue-600 hover:text-blue-800 mr-2', title: 'Edit' }, '✏️');
            edit.addEventListener('click', () => showTokenForm(token));
            const revoke = el('button', { className: 'text-red-600 hover:text-red-800', title: 'Revoke' }, '⛔');
            revoke.addEventListener('click', () => revokeToken(token));
            actions.append(edit, revoke);
        }

        return el('tr', { className: 'border-b align-top' },
            el('td', { className: 'py-3' }, token.name, el('div', { className: 'text-xs text-gray-500 font-mono' }, token.id)),
            el('td', { className: 'py-3' }, el('div', { className: 'flex flex-wrap gap-1' }, ...groupPills)),
            el('td', { className: 'py-3 text-sm' }, formatDate(token.createdAt)),
            el('td', { className: 'py-3 text-sm' }, lastUsed),
            el('td', { className: 'py-3' }, status),
            actions);
    });
    table.replaceChildren(el('table', { className: 'w-full' }, el('thead', {}, header), el('tbody', {}, ...rows)));
}

async function revokeToken(token) {
    if (!confirm(`Revoke the token "${token.name}"? Agents using it lose access immediately.`)) return;
    try {
        await api(`/api/tokens/${encodeURIComponent(token.id)}/revoke`, { method: 'POST', body: '{}' });
    } catch (error) {
        alert('Failed to revoke token: ' + error.message);
    }
    viewTokens();
}

// Create / edit form: presets fill the checkboxes, grouped by tool group.
function renderToolChoices() {
    const presets = document.getElementById('tokenPresets');
    presets.replaceChildren(...Object.entries(catalog.presets).map(([name, tools]) => {
        const button = el('button', { type: 'button', className: 'px-3 py-1 text-sm border border-gray-300 rounded-md hover:bg-gray-100' }, name);
        button.addEventListener('click', () => setSelectedTools(tools));
        return button;
    }));

    const groups = [...new Set(catalog.tools.map(tool => tool.group))];
    document.getElementById('tokenTools').replaceChildren(...groups.map(group => el('div', {},
        el('div', { className: 'mb-1' }, pill(group, GROUP_STYLES[group] || 'bg-gray-100 text-gray-800')),
        el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-1' }, ...catalog.tools
            .filter(tool => tool.group === group)
            .map(tool => {
                const checkbox = el('input', { type: 'checkbox', className: 'w-4 h-4 text-blue-600 rounded', value: tool.name });
                checkbox.addEventListener('change', updateReadSendWarning);
                return el('label', { className: 'flex items-center gap-2 text-sm cursor-pointer', title: tool.description },
                    checkbox, el('span', { className: 'font-mono' }, tool.name));
            })))));
}

function toolCheckboxes() {
    return [...document.querySelectorAll('#tokenTools input[type=checkbox]')];
}

function setSelectedTools(names) {
    toolCheckboxes().forEach(checkbox => { checkbox.checked = names.includes(checkbox.value); });
    updateReadSendWarning();
}

function selectedTools() {
    return toolCheckboxes().filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
}

function updateReadSendWarning() {
    const groups = new Set(selectedTools().map(groupOf));
    document.getElementById('readSendWarning').classList.toggle('hidden', !(groups.has('read') && groups.has('send')));
}

function showTokenForm(token) {
    editingTokenId = token ? token.id : null;
    document.getElementById('tokenFormTitle').textContent = token ? 'Edit agent token' : 'New agent token';
    document.getElementById('tokenName').value = token ? token.name : '';
    document.getElementById('tokenFormError').classList.add('hidden');
    setSelectedTools(token ? token.tools : catalog.presets.readonly || []);
    showAdminView('tokenForm');
}

async function saveToken() {
    const body = JSON.stringify({ name: document.getElementById('tokenName').value, tools: selectedTools() });
    try {
        if (editingTokenId) {
            await api(`/api/tokens/${encodeURIComponent(editingTokenId)}`, { method: 'PATCH', body });
            viewTokens();
        } else {
            const result = await api('/api/tokens', { method: 'POST', body });
            showTokenCreated(result.secret);
        }
    } catch (error) {
        document.getElementById('tokenFormErrorMessage').textContent = error.message;
        document.getElementById('tokenFormError').classList.remove('hidden');
    }
}

// The secret is shown here once, with ready-to-paste client configuration.
// The endpoint URL is the one this page was opened with.
function showTokenCreated(secret) {
    const url = `${window.location.origin}/mcp`;
    document.getElementById('tokenSecret').value = secret;
    document.getElementById('snippetCli').textContent =
        `claude mcp add --transport http imap ${url} --header "Authorization: Bearer ${secret}"`;
    document.getElementById('snippetJson').textContent = JSON.stringify({
        mcpServers: { imap: { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } } }
    }, null, 2);
    showAdminView('tokenCreated');
}

async function copyText(element) {
    const text = 'value' in element ? element.value : element.textContent;
    try {
        await navigator.clipboard.writeText(text);
    } catch (error) {
        // No clipboard API on plain-HTTP origins other than localhost: select it.
        const range = document.createRange();
        range.selectNodeContents(element);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        if (element.select) element.select();
        document.execCommand('copy');
    }
}

// Audit log, newest first, paged with the oldest timestamp shown so far.
async function viewAudit() {
    showAdminView('auditView');
    try {
        tokens = await api('/api/tokens');
    } catch (error) {
        tokens = [];
    }
    const select = document.getElementById('auditToken');
    const current = select.value;
    select.replaceChildren(el('option', { value: '' }, 'All tokens'),
        ...tokens.map(token => el('option', { value: token.id }, `${token.name} (${token.id})`)));
    select.value = current;
    loadAudit(true);
}

async function loadAudit(reset) {
    const table = document.getElementById('auditTable');
    if (reset) auditBefore = null;

    const query = new URLSearchParams({ limit: String(AUDIT_PAGE) });
    const tokenId = document.getElementById('auditToken').value;
    const tool = document.getElementById('auditTool').value.trim();
    if (tokenId) query.set('tokenId', tokenId);
    if (tool) query.set('tool', tool);
    if (auditBefore) query.set('before', auditBefore);

    let entries;
    try {
        entries = await api(`/api/audit?${query}`);
    } catch (error) {
        table.replaceChildren(el('p', { className: 'text-red-800' }, error.message));
        return;
    }

    let body = table.querySelector('tbody');
    if (reset || !body) {
        body = el('tbody');
        const header = el('tr', { className: 'border-b' },
            ...['Time', 'Event', 'Token', 'Tool', 'Outcome', 'Details'].map(title => el('th', { className: 'text-left pb-2 pr-4' }, title)));
        table.replaceChildren(el('table', { className: 'w-full text-sm' }, el('thead', {}, header), body));
    }

    const outcomeStyles = { ok: 'bg-green-100 text-green-800', error: 'bg-yellow-100 text-yellow-800', denied: 'bg-red-100 text-red-800' };
    body.append(...entries.map(entry => {
        const details = [
            entry.ip ? `ip ${entry.ip}` : '',
            entry.durationMs !== undefined ? `${entry.durationMs} ms` : '',
            entry.args ? JSON.stringify(entry.args) : ''
        ].filter(Boolean).join(' · ');
        return el('tr', { className: 'border-b align-top' },
            el('td', { className: 'py-2 pr-4 whitespace-nowrap' }, formatDate(entry.ts)),
            el('td', { className: 'py-2 pr-4' }, entry.event),
            el('td', { className: 'py-2 pr-4' }, entry.tokenName || entry.tokenId || '—'),
            el('td', { className: 'py-2 pr-4 font-mono' }, entry.tool || '—'),
            el('td', { className: 'py-2 pr-4' }, entry.outcome ? pill(entry.outcome, outcomeStyles[entry.outcome] || 'bg-gray-100 text-gray-800') : '—'),
            el('td', { className: 'py-2 font-mono text-xs break-all' }, details));
    }));

    if (reset && entries.length === 0) {
        table.replaceChildren(el('p', { className: 'text-gray-500 text-center py-8' }, 'No audit entries match.'));
    }
    if (entries.length > 0) auditBefore = entries[entries.length - 1].ts;
    document.getElementById('auditMore').classList.toggle('hidden', entries.length < AUDIT_PAGE);
}

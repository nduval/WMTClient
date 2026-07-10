<?php
/**
 * WMT Client - Player Report
 * Login audit log viewer with server-side filtering and pagination
 */

require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';

initSession();

// Access control: the viewer list lives in reportUsernames() (functions.php) —
// shared with report_query/report_export/report_bans so it can't drift per file.
if (!isReportUser()) {
    header('Location: index.php');
    exit;
}

// IP bans load lazily via api/report_bans.php — the old inline fetch here
// blocked the whole page render for up to 3s when Lightsail was slow.
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
    <title>Player Report - <?= APP_NAME ?></title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #0d0d0d;
            color: #ccc;
            min-height: 100vh;
        }

        .report-header {
            background: #1a1a1a;
            border-bottom: 1px solid #333;
            padding: 16px 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;
        }

        .report-header h1 { color: #00ff00; font-size: 1.3em; }
        .report-header .nav-links { display: flex; gap: 16px; font-size: 0.85em; }
        .report-header .nav-links a { color: #888; text-decoration: none; }
        .report-header .nav-links a:hover { color: #00ff00; }

        .toolbar {
            background: #151515;
            border-bottom: 1px solid #2a2a2a;
            padding: 12px 24px;
            display: flex;
            align-items: center;
            gap: 16px;
            flex-wrap: wrap;
        }

        .toolbar input[type="text"] {
            padding: 8px 12px;
            border: 1px solid #333;
            border-radius: 4px;
            background: #1a1a1a;
            color: #fff;
            font-size: 14px;
            width: 250px;
        }

        .toolbar input[type="text"]:focus { outline: none; border-color: #00ff00; }
        .toolbar input[type="text"]::placeholder { color: #666; }

        .toolbar select {
            padding: 8px 12px;
            border: 1px solid #333;
            border-radius: 4px;
            background: #1a1a1a;
            color: #fff;
            font-size: 13px;
        }

        .toolbar .stats { color: #666; font-size: 0.82em; margin-left: auto; }

        .table-wrap { overflow-x: auto; padding: 0 24px 0; }

        table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }

        th {
            background: #1a1a1a;
            color: #00ff00;
            padding: 10px 14px;
            text-align: left;
            border-bottom: 2px solid #333;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            position: sticky;
            top: 0;
            z-index: 10;
        }

        th:hover { background: #222; }
        th .sort-arrow { color: #555; margin-left: 4px; font-size: 10px; }
        th.active-sort .sort-arrow { color: #00ff00; }

        td { padding: 8px 14px; border-bottom: 1px solid #1e1e1e; white-space: nowrap; }
        tr:hover td { background: #1a1a1a; }

        .col-timestamp { min-width: 180px; color: #888; }
        .col-account { color: #6699ff; }
        .col-character { color: #00ff00; }
        .col-realm { text-align: center; }
        .col-ip { font-family: monospace; color: #aaa; }
        .col-country { text-align: center; }
        .col-city { color: #ccc; }
        .col-asn { color: #888; font-size: 12px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }

        .realm-badge, .activity-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
            /* fallback for activity types with no specific rule below —
               still reads as a badge instead of bare text */
            background: rgba(136,136,136,0.15);
            color: #aaa;
        }

        .realm-3k { background: rgba(0,255,0,0.15); color: #00ff00; }
        .realm-3s { background: rgba(102,153,255,0.15); color: #6699ff; }
        .activity-login      { background: rgba(0,255,0,0.15);     color: #00ff00; }
        .activity-reconnect  { background: rgba(102,153,255,0.15);  color: #6699ff; }
        .activity-disconnect { background: rgba(255,102,102,0.15);  color: #ff6666; }
        /* logout = voluntary exit (user typed quit). Distinct from
           involuntary disconnect (linkdeath/timeout/browser close). */
        .activity-logout     { background: rgba(255,170,102,0.15);  color: #ffaa66; }
        /* identified = sniffer-captured real MUD char name. Only fired
           when the captured name DIFFERS from the WMT slot label, so
           presence of this row is itself meaningful (mismatch flag). */
        .activity-identified { background: rgba(170,102,255,0.15);  color: #aa66ff; }
        .activity-login_failed { background: rgba(255,51,51,0.2);   color: #ff5555; }
        .activity-register   { background: rgba(0,204,204,0.15);    color: #00cccc; }
        .activity-relink     { background: rgba(204,204,102,0.15);  color: #cccc66; }

        .pagination {
            padding: 16px 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }

        .pagination button {
            padding: 6px 14px;
            border: 1px solid #333;
            border-radius: 4px;
            background: #1a1a1a;
            color: #ccc;
            cursor: pointer;
            font-size: 13px;
        }

        .pagination button:hover { border-color: #00ff00; color: #00ff00; }
        .pagination button:disabled { color: #444; border-color: #222; cursor: default; }
        .pagination button.active { background: #00ff00; color: #000; border-color: #00ff00; font-weight: bold; }
        .pagination .page-info { color: #666; font-size: 12px; }

        .no-results { text-align: center; padding: 40px; color: #555; }
        .loading { text-align: center; padding: 40px; color: #888; }

        /* IP Bans Panel */
        .bans-panel {
            margin: 24px;
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            overflow: hidden;
        }

        .bans-panel h2 {
            background: #222;
            color: #ff6666;
            font-size: 1em;
            padding: 12px 16px;
            margin: 0;
            border-bottom: 1px solid #333;
        }

        .bans-list { padding: 0; margin: 0; list-style: none; }

        .bans-list li {
            padding: 10px 16px;
            border-bottom: 1px solid #1e1e1e;
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 13px;
        }

        .bans-list li:last-child { border-bottom: none; }

        .ban-type {
            font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 3px;
            background: rgba(255,102,102,0.15); color: #ff6666;
            text-transform: uppercase; min-width: 40px; text-align: center;
        }

        .ban-value { font-family: monospace; color: #ccc; }
        .ban-reason { color: #888; font-size: 12px; }
        .ban-date { color: #555; font-size: 11px; margin-left: auto; }
        .bans-empty { padding: 16px; color: #555; text-align: center; }

        @media (max-width: 768px) {
            .report-header { padding: 12px 16px; }
            .toolbar { padding: 10px 16px; }
            .toolbar input[type="text"] { width: 100%; }
            .table-wrap { padding: 0 8px; }
            td, th { padding: 6px 8px; font-size: 12px; }
        }
    </style>
</head>
<body>
    <div class="report-header">
        <h1>Player Report</h1>
        <div class="nav-links">
            <a href="characters.php">Characters</a>
            <?php if (isAdminUser()): ?><a href="admin.php">Admin</a><?php endif; ?>
            <a href="#" onclick="exportCsv(); return false;">Export CSV</a>
        </div>
    </div>

    <div class="toolbar">
        <input type="text" id="search" placeholder="Search account, character, IP, ASN...">
        <!-- Options are built from the activity types actually in the data
             (report_query returns distinct counts) — a hardcoded list left
             login_failed/register/relink unfilterable for months. -->
        <select id="activity-filter">
            <option value="">All Activity</option>
        </select>
        <select id="realm-filter">
            <option value="">All Realms</option>
            <option value="3K">3K</option>
            <option value="3S">3S</option>
        </select>
        <select id="time-filter">
            <option value="">All Time</option>
            <option value="1">Last 24 Hours</option>
            <option value="7">Last 7 Days</option>
            <option value="30">Last 30 Days</option>
            <option value="90">Last 90 Days</option>
        </select>
        <span class="stats" id="stats">Loading...</span>
    </div>

    <div class="table-wrap">
        <table id="report-table">
            <thead>
                <tr>
                    <th data-sort="timestamp" class="col-timestamp active-sort">Time <span class="sort-arrow">▼</span></th>
                    <th data-sort="activity" class="col-activity">Activity <span class="sort-arrow">▼</span></th>
                    <th data-sort="account" class="col-account">Account <span class="sort-arrow">▼</span></th>
                    <th data-sort="character" class="col-character">Character <span class="sort-arrow">▼</span></th>
                    <th data-sort="realm" class="col-realm">Realm <span class="sort-arrow">▼</span></th>
                    <th data-sort="ip" class="col-ip">IP <span class="sort-arrow">▼</span></th>
                    <th data-sort="country" class="col-country">Country <span class="sort-arrow">▼</span></th>
                    <th data-sort="city" class="col-city">City <span class="sort-arrow">▼</span></th>
                    <th data-sort="asn" class="col-asn">ASN <span class="sort-arrow">▼</span></th>
                </tr>
            </thead>
            <tbody id="report-body">
                <tr><td colspan="9" class="loading">Loading...</td></tr>
            </tbody>
        </table>
    </div>

    <div class="pagination" id="pagination"></div>

    <div class="bans-panel">
        <h2 id="bans-title">IP Bans</h2>
        <div id="bans-body"><div class="bans-empty">Loading…</div></div>
    </div>

<script>
    let currentSort = 'timestamp';
    let currentDir = 'desc';
    let currentPage = 1;
    let searchTimeout = null;

    const perPage = 100;

    // Debounced search
    document.getElementById('search').addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => { currentPage = 1; loadData(); }, 300);
    });

    // Filter changes
    ['activity-filter', 'realm-filter', 'time-filter'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => { currentPage = 1; loadData(); });
    });

    // Sort headers
    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (currentSort === col) {
                currentDir = currentDir === 'desc' ? 'asc' : 'desc';
            } else {
                currentSort = col;
                currentDir = col === 'timestamp' ? 'desc' : 'asc';
            }
            currentPage = 1;
            loadData();
        });
    });

    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    // CSS-class-safe slug for badge classes — anything else could break out
    // of the class attribute (activity values come from the audit CSV).
    function cssSlug(str) {
        return String(str || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    }

    // ISO timestamp → compact LOCAL time for display; the raw value goes in
    // the title so the original (with offset) is a hover away.
    function fmtTs(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return esc(iso || '');
        const p = n => String(n).padStart(2, '0');
        const local = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        return `<span title="${esc(iso)}">${local}</span>`;
    }

    function currentParams() {
        return new URLSearchParams({
            search: document.getElementById('search').value,
            activity: document.getElementById('activity-filter').value,
            realm: document.getElementById('realm-filter').value,
            days: document.getElementById('time-filter').value,
            sort: currentSort,
            dir: currentDir
        });
    }

    // Rebuild the Activity dropdown from the distinct types actually in the
    // data (with counts), preserving the current selection.
    function updateActivityOptions(activities) {
        if (!activities) return;
        const sel = document.getElementById('activity-filter');
        const current = sel.value;
        const label = a => a.charAt(0).toUpperCase() + a.slice(1).replace(/_/g, ' ');
        sel.innerHTML = '<option value="">All Activity</option>' + Object.entries(activities)
            .map(([a, n]) => `<option value="${esc(a)}">${esc(label(a))} (${n})</option>`).join('');
        sel.value = current;   // reselect (falls back to All if the type vanished)
    }

    async function loadData() {
        const params = currentParams();
        params.set('page', currentPage);
        params.set('per_page', perPage);

        // Update sort header styling + direction arrow
        document.querySelectorAll('th[data-sort]').forEach(th => {
            const active = th.dataset.sort === currentSort;
            th.classList.toggle('active-sort', active);
            const arrow = th.querySelector('.sort-arrow');
            if (arrow) arrow.textContent = active ? (currentDir === 'asc' ? '▲' : '▼') : '▼';
        });

        try {
            const res = await fetch('api/report_query.php?' + params);
            const data = await res.json();
            if (!data.success) throw new Error(data.error);

            updateActivityOptions(data.activities);

            const tbody = document.getElementById('report-body');
            if (data.rows.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" class="no-results">No results found.</td></tr>';
            } else {
                tbody.innerHTML = data.rows.map(r => `<tr>
                    <td class="col-timestamp">${fmtTs(r.timestamp || '')}</td>
                    <td class="col-activity"><span class="activity-badge activity-${cssSlug(r.activity || 'login')}">${esc(r.activity || 'login')}</span></td>
                    <td class="col-account">${esc(r.account || '')}</td>
                    <td class="col-character">${esc(r.character || '')}</td>
                    <td class="col-realm"><span class="realm-badge realm-${cssSlug(r.realm || '3k')}">${esc(r.realm || '')}</span></td>
                    <td class="col-ip">${esc(r.ip || '')}</td>
                    <td class="col-country">${esc(r.country || '')}</td>
                    <td class="col-city">${esc(r.city || '')}</td>
                    <td class="col-asn">${esc(r.asn || '')}</td>
                </tr>`).join('');
            }

            // Stats
            const statsText = data.filtered === data.total
                ? `${data.total} entries`
                : `${data.filtered} of ${data.total} entries`;
            document.getElementById('stats').textContent = statsText;

            // Pagination
            renderPagination(data.page, data.total_pages, data.filtered);
        } catch (e) {
            document.getElementById('report-body').innerHTML =
                `<tr><td colspan="9" class="no-results">Error loading data: ${esc(e.message)}</td></tr>`;
        }
    }

    function renderPagination(page, totalPages, totalFiltered) {
        const el = document.getElementById('pagination');
        if (totalPages <= 1) { el.innerHTML = ''; return; }

        let html = '';
        html += `<button onclick="goPage(1)" ${page === 1 ? 'disabled' : ''}>&laquo;</button>`;
        html += `<button onclick="goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>&lsaquo;</button>`;

        // Show page numbers around current page
        const start = Math.max(1, page - 2);
        const end = Math.min(totalPages, page + 2);
        for (let i = start; i <= end; i++) {
            html += `<button onclick="goPage(${i})" class="${i === page ? 'active' : ''}">${i}</button>`;
        }

        html += `<button onclick="goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>&rsaquo;</button>`;
        html += `<button onclick="goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>&raquo;</button>`;
        html += `<span class="page-info">Page ${page} of ${totalPages}</span>`;
        el.innerHTML = html;
    }

    function goPage(p) {
        currentPage = p;
        loadData();
    }

    // Export honors the filters/sort you're looking at; with everything
    // blank it exports the full log, same as before.
    function exportCsv() {
        window.location.href = 'api/report_export.php?' + currentParams();
    }

    // IP bans — loaded async so a slow Lightsail can't stall the page render.
    async function loadBans() {
        const body = document.getElementById('bans-body');
        const title = document.getElementById('bans-title');
        try {
            const res = await fetch('api/report_bans.php');
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'failed');
            const bans = data.bans || [];
            title.textContent = `IP Bans (${bans.length})`;
            if (!bans.length) {
                body.innerHTML = '<div class="bans-empty">No IP bans configured.</div>';
                return;
            }
            body.innerHTML = '<ul class="bans-list">' + bans.map(b => {
                const when = b.banned_at ? new Date(b.banned_at) : null;
                const whenStr = when && !isNaN(when.getTime())
                    ? `${when.getFullYear()}-${String(when.getMonth()+1).padStart(2,'0')}-${String(when.getDate()).padStart(2,'0')} ${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')}`
                    : '';
                return `<li>
                    <span class="ban-type">${esc(b.type || '')}</span>
                    <span class="ban-value">${esc(b.value || '')}</span>
                    <span class="ban-reason">${esc(b.reason || '')}</span>
                    <span class="ban-date">${esc(whenStr)}</span>
                </li>`;
            }).join('') + '</ul>';
        } catch (e) {
            title.textContent = 'IP Bans';
            body.innerHTML = `<div class="bans-empty">Could not load bans: ${esc(e.message)}</div>`;
        }
    }

    // Initial load
    loadData();
    loadBans();
</script>
</body>
</html>

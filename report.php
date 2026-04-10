<?php
/**
 * WMT Client - Player Report
 * Login audit log viewer with server-side filtering and pagination
 */

require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';

initSession();

// Access control: admins + designated report viewers
$REPORT_USERS = ['nathan', 'amy', 'adalius']; // Add usernames who can view this page

if (!isLoggedIn() || !in_array(getCurrentUsername(), $REPORT_USERS)) {
    header('Location: index.php');
    exit;
}

// Fetch IP bans from Lightsail
$ipBans = [];
$adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
if ($adminKey) {
    $ctx = stream_context_create([
        'http' => [
            'timeout' => 3,
            'header' => "X-Admin-Key: {$adminKey}\r\n"
        ]
    ]);
    $bansData = @file_get_contents('https://ws.wemudtogether.com/ip-bans', false, $ctx);
    if ($bansData) {
        $parsed = json_decode($bansData, true);
        if ($parsed && $parsed['success']) $ipBans = $parsed['bans'] ?? [];
    }
}
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
        }

        .realm-3k { background: rgba(0,255,0,0.15); color: #00ff00; }
        .realm-3s { background: rgba(102,153,255,0.15); color: #6699ff; }
        .activity-login { background: rgba(0,255,0,0.15); color: #00ff00; }
        .activity-reconnect { background: rgba(102,153,255,0.15); color: #6699ff; }
        .activity-disconnect { background: rgba(255,102,102,0.15); color: #ff6666; }

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
            <?php if (getCurrentUsername() === 'nathan'): ?><a href="admin.php">Admin</a><?php endif; ?>
            <a href="#" onclick="exportCsv(); return false;">Export CSV</a>
        </div>
    </div>

    <div class="toolbar">
        <input type="text" id="search" placeholder="Search account, character, IP, ASN...">
        <select id="activity-filter">
            <option value="">All Activity</option>
            <option value="login">Login</option>
            <option value="reconnect">Reconnect</option>
            <option value="disconnect">Disconnect</option>
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
        <h2>IP Bans (<?= count($ipBans) ?>)</h2>
<?php if (empty($ipBans)): ?>
        <div class="bans-empty">No IP bans configured.</div>
<?php else: ?>
        <ul class="bans-list">
<?php foreach ($ipBans as $ban): ?>
            <li>
                <span class="ban-type"><?= htmlspecialchars($ban['type'] ?? '') ?></span>
                <span class="ban-value"><?= htmlspecialchars($ban['value'] ?? '') ?></span>
                <span class="ban-reason"><?= htmlspecialchars($ban['reason'] ?? '') ?></span>
                <span class="ban-date"><?= isset($ban['banned_at']) ? date('M j, Y', strtotime($ban['banned_at'])) : '' ?></span>
            </li>
<?php endforeach; ?>
        </ul>
<?php endif; ?>
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

    async function loadData() {
        const params = new URLSearchParams({
            search: document.getElementById('search').value,
            activity: document.getElementById('activity-filter').value,
            realm: document.getElementById('realm-filter').value,
            days: document.getElementById('time-filter').value,
            sort: currentSort,
            dir: currentDir,
            page: currentPage,
            per_page: perPage
        });

        // Update sort header styling
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.classList.toggle('active-sort', th.dataset.sort === currentSort);
        });

        try {
            const res = await fetch('api/report_query.php?' + params);
            const data = await res.json();
            if (!data.success) throw new Error(data.error);

            const tbody = document.getElementById('report-body');
            if (data.rows.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" class="no-results">No results found.</td></tr>';
            } else {
                tbody.innerHTML = data.rows.map(r => `<tr>
                    <td class="col-timestamp">${esc(r.timestamp || '')}</td>
                    <td class="col-activity"><span class="activity-badge activity-${(r.activity||'login').toLowerCase()}">${esc(r.activity || 'login')}</span></td>
                    <td class="col-account">${esc(r.account || '')}</td>
                    <td class="col-character">${esc(r.character || '')}</td>
                    <td class="col-realm"><span class="realm-badge realm-${(r.realm||'3k').toLowerCase()}">${esc(r.realm || '')}</span></td>
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

    function exportCsv() {
        window.location.href = 'api/report_export.php';
    }

    // Initial load
    loadData();
</script>
</body>
</html>

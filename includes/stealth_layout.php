<?php
/**
 * Shared layout for stealth domain pages.
 * Usage: require this file, then call stealth_header($title, $activeNav) and stealth_footer()
 */

// Block access from non-stealth domain
function stealth_guard() {
    if (!isset($_SERVER['HTTP_HOST']) || $_SERVER['HTTP_HOST'] !== '3kbusinessservices.com') {
        header('HTTP/1.0 404 Not Found');
        exit;
    }
}

function stealth_header($title, $activeNav = '') {
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="3K Business Services provides enterprise knowledge management, workforce training solutions, and real-time analytics for modern organizations.">
    <meta name="author" content="3K Business Services">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📊</text></svg>">
    <title><?= htmlspecialchars($title) ?> - 3K Business Services</title>
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": "3K Business Services",
        "url": "https://3kbusinessservices.com",
        "logo": "https://3kbusinessservices.com/assets/logo.svg",
        "description": "Enterprise knowledge management and workforce training solutions.",
        "foundingDate": "2024",
        "address": {
            "@type": "PostalAddress",
            "addressLocality": "Austin",
            "addressRegion": "TX",
            "addressCountry": "US"
        },
        "contactPoint": {
            "@type": "ContactPoint",
            "telephone": "+1-512-555-0147",
            "contactType": "customer service"
        }
    }
    </script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f0f2f5;
            color: #333;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }
        a { color: #1a56db; text-decoration: none; }
        a:hover { color: #1648b8; }

        /* Nav */
        .s-nav {
            background: #fff;
            border-bottom: 1px solid #e0e0e0;
            padding: 0 40px;
            height: 60px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 1px 3px rgba(0,0,0,0.06);
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .s-nav-brand {
            display: flex;
            align-items: center;
            gap: 10px;
            text-decoration: none;
        }
        .s-nav-brand svg { width: 32px; height: 32px; }
        .s-nav-brand span {
            font-size: 1.1em;
            font-weight: 700;
            color: #1e3a5f;
            letter-spacing: -0.3px;
        }
        .s-nav-links { display: flex; gap: 28px; align-items: center; }
        .s-nav-links a {
            color: #5a6577;
            text-decoration: none;
            font-size: 0.88em;
            font-weight: 500;
            transition: color 0.2s;
            padding-bottom: 2px;
            border-bottom: 2px solid transparent;
        }
        .s-nav-links a:hover { color: #1a56db; }
        .s-nav-links a.active { color: #1a56db; border-bottom-color: #1a56db; }
        .s-nav-links .s-nav-cta {
            background: #1a56db;
            color: #fff;
            padding: 8px 18px;
            border-radius: 6px;
            font-weight: 600;
            transition: background 0.2s;
            border: none;
        }
        .s-nav-links .s-nav-cta:hover { background: #1648b8; color: #fff; }

        /* Page content */
        .s-page { flex: 1; }

        /* Hero banner (reusable) */
        .s-page-hero {
            background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
            color: #fff;
            padding: 60px 40px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        .s-page-hero::before {
            content: '';
            position: absolute;
            top: -40%;
            right: -10%;
            width: 500px;
            height: 500px;
            background: radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%);
            border-radius: 50%;
        }
        .s-page-hero > * { position: relative; z-index: 1; }
        .s-page-hero h1 { font-size: 2.2em; font-weight: 700; margin-bottom: 12px; }
        .s-page-hero p { font-size: 1.05em; color: rgba(255,255,255,0.8); max-width: 600px; margin: 0 auto; line-height: 1.6; }

        /* Content sections */
        .s-section {
            max-width: 960px;
            margin: 0 auto;
            padding: 50px 40px;
        }
        .s-section h2 {
            font-size: 1.6em;
            color: #1e3a5f;
            margin-bottom: 16px;
            font-weight: 700;
        }
        .s-section h3 {
            font-size: 1.15em;
            color: #1e3a5f;
            margin-bottom: 10px;
            font-weight: 600;
        }
        .s-section p {
            color: #4b5563;
            line-height: 1.7;
            margin-bottom: 16px;
            font-size: 0.95em;
        }

        /* Card grid */
        .s-card-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 24px;
            margin-top: 30px;
        }
        .s-card {
            background: #fff;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            padding: 28px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.05);
            transition: box-shadow 0.2s, transform 0.2s;
        }
        .s-card:hover {
            box-shadow: 0 4px 16px rgba(0,0,0,0.1);
            transform: translateY(-2px);
        }
        .s-card-icon {
            font-size: 2em;
            margin-bottom: 14px;
        }
        .s-card h3 { margin-bottom: 8px; }
        .s-card p { font-size: 0.88em; color: #6b7280; margin-bottom: 0; }

        /* Stats bar */
        .s-stats-bar {
            background: #fff;
            border-top: 1px solid #e5e7eb;
            border-bottom: 1px solid #e5e7eb;
            padding: 30px 40px;
            display: flex;
            justify-content: center;
            gap: 60px;
            text-align: center;
        }
        .s-stats-bar .s-sb-num { font-size: 2em; font-weight: 700; color: #1a56db; }
        .s-stats-bar .s-sb-label { font-size: 0.82em; color: #6b7280; margin-top: 4px; }

        /* CTA band */
        .s-cta-band {
            background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
            color: #fff;
            text-align: center;
            padding: 50px 40px;
        }
        .s-cta-band h2 { font-size: 1.6em; margin-bottom: 12px; color: #fff; }
        .s-cta-band p { color: rgba(255,255,255,0.8); margin-bottom: 24px; font-size: 1em; }
        .s-cta-band .s-cta-btn {
            display: inline-block;
            background: #fff;
            color: #1a56db;
            padding: 12px 32px;
            border-radius: 6px;
            font-weight: 700;
            font-size: 0.95em;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .s-cta-band .s-cta-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            color: #1648b8;
        }

        /* Footer */
        .s-footer {
            background: #1e293b;
            color: #94a3b8;
            padding: 40px;
        }
        .s-footer-inner {
            max-width: 960px;
            margin: 0 auto;
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            gap: 40px;
        }
        .s-footer h4 { color: #fff; font-size: 0.9em; margin-bottom: 14px; }
        .s-footer p { font-size: 0.82em; line-height: 1.6; color: #94a3b8; }
        .s-footer ul { list-style: none; }
        .s-footer ul li { margin-bottom: 8px; }
        .s-footer ul a { color: #94a3b8; font-size: 0.82em; }
        .s-footer ul a:hover { color: #fff; }
        .s-footer-bottom {
            max-width: 960px;
            margin: 24px auto 0;
            padding-top: 20px;
            border-top: 1px solid #334155;
            display: flex;
            justify-content: space-between;
            font-size: 0.75em;
        }

        @media (max-width: 768px) {
            .s-nav { padding: 0 20px; }
            .s-nav-links a:not(.s-nav-cta) { display: none; }
            .s-page-hero { padding: 40px 20px; }
            .s-page-hero h1 { font-size: 1.6em; }
            .s-section { padding: 30px 20px; }
            .s-stats-bar { gap: 30px; flex-wrap: wrap; padding: 20px; }
            .s-footer-inner { grid-template-columns: 1fr 1fr; gap: 24px; }
            .s-footer-bottom { flex-direction: column; gap: 8px; }
        }
    </style>
<?php } // end stealth_header ?>

<?php function stealth_nav($activeNav = '') { ?>
<nav class="s-nav">
    <a href="/" class="s-nav-brand">
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="6" fill="#1e3a5f"/>
            <text x="4" y="23" font-family="Segoe UI,sans-serif" font-weight="700" font-size="16" fill="#fff">3K</text>
        </svg>
        <span>3K Business Services</span>
    </a>
    <div class="s-nav-links">
        <a href="/about.php"<?= $activeNav === 'about' ? ' class="active"' : '' ?>>About</a>
        <a href="/solutions.php"<?= $activeNav === 'solutions' ? ' class="active"' : '' ?>>Solutions</a>
        <a href="/contact.php"<?= $activeNav === 'contact' ? ' class="active"' : '' ?>>Contact</a>
        <a href="/" class="s-nav-cta">Client Portal</a>
    </div>
</nav>
<?php } ?>

<?php function stealth_footer() { ?>
<footer class="s-footer">
    <div class="s-footer-inner">
        <div>
            <h4>3K Business Services</h4>
            <p>Empowering organizations with integrated knowledge management, workforce training, and real-time analytics since 2024.</p>
        </div>
        <div>
            <h4>Solutions</h4>
            <ul>
                <li><a href="/solutions.php">Knowledge Management</a></li>
                <li><a href="/solutions.php">Workforce Training</a></li>
                <li><a href="/solutions.php">Analytics &amp; Reporting</a></li>
                <li><a href="/solutions.php">Compliance Tools</a></li>
            </ul>
        </div>
        <div>
            <h4>Company</h4>
            <ul>
                <li><a href="/about.php">About Us</a></li>
                <li><a href="/contact.php">Contact</a></li>
                <li><a href="/privacy.php">Privacy Policy</a></li>
                <li><a href="/terms.php">Terms of Service</a></li>
            </ul>
        </div>
        <div>
            <h4>Resources</h4>
            <ul>
                <li><a href="/">Client Portal</a></li>
                <li><a href="/about.php">About Us</a></li>
                <li><a href="/solutions.php">Our Platform</a></li>
                <li><a href="/contact.php">Get Support</a></li>
            </ul>
        </div>
    </div>
    <div class="s-footer-bottom">
        <div>&copy; 2024&ndash;2026 3K Business Services, LLC. All rights reserved.</div>
        <div>Austin, TX &middot; New York, NY &middot; London, UK</div>
    </div>
</footer>
</body>
</html>
<?php } ?>

<?php
require_once __DIR__ . '/includes/stealth_layout.php';
stealth_guard();
stealth_header('About Us', 'about');
?>
</head>
<body>
<?php stealth_nav('about'); ?>

<div class="s-page">
    <div class="s-page-hero">
        <h1>About 3K Business Services</h1>
        <p>We build tools that help organizations manage knowledge, develop talent, and make better decisions through data.</p>
    </div>

    <div class="s-section">
        <h2>Our Story</h2>
        <p>3K Business Services was founded in 2024 with a simple observation: enterprise knowledge management was broken. Organizations were spending millions on training platforms that employees didn't use, compliance tools that created more paperwork than clarity, and analytics dashboards that nobody understood.</p>
        <p>We set out to build something different &mdash; an integrated platform that combines knowledge management, workforce development, and business intelligence into a single, intuitive experience. Our approach is rooted in the belief that the best enterprise software should feel as natural as the consumer apps people use every day.</p>
        <p>Today, we serve over 500 organizations across 18 countries, from mid-market companies to Fortune 500 enterprises. Our platform processes over 2 million learning interactions per month and has helped our clients reduce compliance incidents by an average of 34%.</p>
    </div>

    <div class="s-stats-bar">
        <div>
            <div class="s-sb-num">500+</div>
            <div class="s-sb-label">Organizations Served</div>
        </div>
        <div>
            <div class="s-sb-num">18</div>
            <div class="s-sb-label">Countries</div>
        </div>
        <div>
            <div class="s-sb-num">2M+</div>
            <div class="s-sb-label">Monthly Interactions</div>
        </div>
        <div>
            <div class="s-sb-num">34%</div>
            <div class="s-sb-label">Avg. Incident Reduction</div>
        </div>
    </div>

    <div class="s-section">
        <h2>Our Values</h2>
        <div class="s-card-grid">
            <div class="s-card">
                <div class="s-card-icon">🎯</div>
                <h3>Clarity Over Complexity</h3>
                <p>Enterprise software doesn't have to be complicated. We obsess over simplicity so your team can focus on what matters.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">🔒</div>
                <h3>Trust &amp; Security</h3>
                <p>Your data is your most valuable asset. We maintain SOC 2 Type II compliance and undergo quarterly third-party security audits.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">🤝</div>
                <h3>Customer Partnership</h3>
                <p>We succeed when you succeed. Every customer gets a dedicated success manager and direct access to our engineering team.</p>
            </div>
        </div>
    </div>

    <div class="s-section">
        <h2>Leadership</h2>
        <div class="s-card-grid">
            <div class="s-card" style="text-align: center;">
                <div style="width: 80px; height: 80px; background: #e5e7eb; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 2em; color: #9ca3af;">JR</div>
                <h3>James Richardson</h3>
                <p style="color: #1a56db; font-weight: 500; margin-bottom: 8px;">Co-Founder &amp; CEO</p>
                <p>Former VP of Product at Workday. 15 years building enterprise platforms.</p>
            </div>
            <div class="s-card" style="text-align: center;">
                <div style="width: 80px; height: 80px; background: #e5e7eb; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 2em; color: #9ca3af;">AL</div>
                <h3>Anya Levinson</h3>
                <p style="color: #1a56db; font-weight: 500; margin-bottom: 8px;">Co-Founder &amp; CTO</p>
                <p>Ex-Google engineer. Led infrastructure for Google Workspace education tools.</p>
            </div>
            <div class="s-card" style="text-align: center;">
                <div style="width: 80px; height: 80px; background: #e5e7eb; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 2em; color: #9ca3af;">MK</div>
                <h3>Marcus Kim</h3>
                <p style="color: #1a56db; font-weight: 500; margin-bottom: 8px;">VP of Customer Success</p>
                <p>Built the CS organization at Lattice from 10 to 200+ customers.</p>
            </div>
        </div>
    </div>

    <div class="s-cta-band">
        <h2>Ready to transform your organization?</h2>
        <p>Join 500+ companies using 3K Business Services to drive workforce excellence.</p>
        <a href="/contact.php" class="s-cta-btn">Get in Touch</a>
    </div>
</div>

<?php stealth_footer(); ?>

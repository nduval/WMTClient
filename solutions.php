<?php
require_once __DIR__ . '/includes/stealth_layout.php';
stealth_guard();
stealth_header('Solutions', 'solutions');
?>
</head>
<body>
<?php stealth_nav('solutions'); ?>

<div class="s-page">
    <div class="s-page-hero">
        <h1>Enterprise Solutions</h1>
        <p>A complete platform for knowledge management, workforce training, and organizational intelligence.</p>
    </div>

    <div class="s-section">
        <h2>Knowledge Management</h2>
        <p>Centralize your organization's institutional knowledge in a single, searchable platform. Our AI-powered knowledge base learns from your team's interactions and surfaces the right information at the right time.</p>
        <div class="s-card-grid">
            <div class="s-card">
                <div class="s-card-icon">📚</div>
                <h3>Smart Knowledge Base</h3>
                <p>AI-powered search and auto-categorization. Import from Confluence, SharePoint, Google Drive, and 40+ integrations.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">🔍</div>
                <h3>Semantic Search</h3>
                <p>Natural language queries return relevant results across all your content sources. No more hunting through folders.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">📊</div>
                <h3>Knowledge Analytics</h3>
                <p>Identify knowledge gaps, track article effectiveness, and measure team engagement with real-time dashboards.</p>
            </div>
        </div>
    </div>

    <div class="s-stats-bar">
        <div>
            <div class="s-sb-num">89%</div>
            <div class="s-sb-label">Faster Onboarding</div>
        </div>
        <div>
            <div class="s-sb-num">3.2x</div>
            <div class="s-sb-label">Knowledge Reuse</div>
        </div>
        <div>
            <div class="s-sb-num">67%</div>
            <div class="s-sb-label">Fewer Support Tickets</div>
        </div>
        <div>
            <div class="s-sb-num">40+</div>
            <div class="s-sb-label">Integrations</div>
        </div>
    </div>

    <div class="s-section">
        <h2>Workforce Training</h2>
        <p>Build, deliver, and track training programs that actually engage your team. From compliance courses to skill development paths, our platform makes professional development measurable and effective.</p>
        <div class="s-card-grid">
            <div class="s-card">
                <div class="s-card-icon">🎓</div>
                <h3>Learning Paths</h3>
                <p>Design structured curricula with prerequisites, assessments, and certifications. Track progress at individual and team levels.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">✅</div>
                <h3>Compliance Management</h3>
                <p>Automated compliance tracking with audit trails. Set deadlines, send reminders, and generate reports for regulators.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">🏆</div>
                <h3>Skill Assessments</h3>
                <p>Measure competencies with customizable assessments. Identify skill gaps and recommend targeted development resources.</p>
            </div>
        </div>
    </div>

    <div class="s-section">
        <h2>Analytics &amp; Reporting</h2>
        <p>Make data-driven decisions about your workforce development strategy with real-time analytics and customizable reporting.</p>
        <div class="s-card-grid">
            <div class="s-card">
                <div class="s-card-icon">📈</div>
                <h3>Executive Dashboards</h3>
                <p>Real-time visibility into training completion rates, knowledge engagement, and compliance status across your entire organization.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">🔔</div>
                <h3>Automated Alerts</h3>
                <p>Get notified about compliance deadlines, engagement drops, and knowledge gaps before they become problems.</p>
            </div>
            <div class="s-card">
                <div class="s-card-icon">📋</div>
                <h3>Custom Reports</h3>
                <p>Build reports for any audience &mdash; from board presentations to team standups. Export to PDF, Excel, or schedule automated delivery.</p>
            </div>
        </div>
    </div>

    <div class="s-section">
        <h2>Enterprise-Grade Security</h2>
        <p>Your data security is non-negotiable. Our platform is built from the ground up with enterprise security requirements in mind.</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px;">
            <div style="display: flex; align-items: center; gap: 10px; padding: 14px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">
                <span style="color: #1a56db; font-weight: 700;">&#10003;</span> SOC 2 Type II Certified
            </div>
            <div style="display: flex; align-items: center; gap: 10px; padding: 14px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">
                <span style="color: #1a56db; font-weight: 700;">&#10003;</span> SAML 2.0 / SSO
            </div>
            <div style="display: flex; align-items: center; gap: 10px; padding: 14px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">
                <span style="color: #1a56db; font-weight: 700;">&#10003;</span> 256-bit AES Encryption
            </div>
            <div style="display: flex; align-items: center; gap: 10px; padding: 14px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">
                <span style="color: #1a56db; font-weight: 700;">&#10003;</span> GDPR Compliant
            </div>
            <div style="display: flex; align-items: center; gap: 10px; padding: 14px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">
                <span style="color: #1a56db; font-weight: 700;">&#10003;</span> Role-Based Access Control
            </div>
            <div style="display: flex; align-items: center; gap: 10px; padding: 14px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">
                <span style="color: #1a56db; font-weight: 700;">&#10003;</span> 99.9% Uptime SLA
            </div>
        </div>
    </div>

    <div class="s-cta-band">
        <h2>See the platform in action</h2>
        <p>Schedule a personalized demo with our solutions team.</p>
        <a href="/contact.php" class="s-cta-btn">Request a Demo</a>
    </div>
</div>

<?php stealth_footer(); ?>

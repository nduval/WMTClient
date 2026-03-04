<?php
require_once __DIR__ . '/includes/stealth_layout.php';
stealth_guard();
stealth_header('Privacy Policy');
?>
</head>
<body>
<?php stealth_nav(); ?>

<div class="s-page">
    <div class="s-page-hero" style="padding: 40px;">
        <h1>Privacy Policy</h1>
        <p>Last updated: January 15, 2026</p>
    </div>

    <div class="s-section" style="max-width: 760px;">
        <h2>1. Introduction</h2>
        <p>3K Business Services, LLC ("3KBS," "we," "us," or "our") is committed to protecting your privacy. This Privacy Policy describes how we collect, use, disclose, and safeguard information when you use our enterprise knowledge management platform and related services (collectively, the "Services").</p>

        <h2>2. Information We Collect</h2>
        <h3>2.1 Account Information</h3>
        <p>When you create an account, we collect your username, email address, and encrypted password. For enterprise accounts, we may also collect your organizational affiliation, department, and role.</p>

        <h3>2.2 Usage Data</h3>
        <p>We automatically collect information about how you interact with our Services, including pages visited, features used, session duration, and device information (browser type, operating system, IP address).</p>

        <h3>2.3 Content Data</h3>
        <p>We store the content you create, upload, or share through the Services, including documents, training materials, assessments, and communications within the platform.</p>

        <h2>3. How We Use Your Information</h2>
        <p>We use the information we collect to:</p>
        <ul style="margin: 12px 0 16px 24px; color: #4b5563; line-height: 1.8; font-size: 0.95em;">
            <li>Provide, maintain, and improve the Services</li>
            <li>Authenticate users and manage access controls</li>
            <li>Generate analytics and reports for your organization</li>
            <li>Send service-related communications (account recovery, security alerts)</li>
            <li>Comply with legal obligations and enforce our Terms of Service</li>
            <li>Detect, prevent, and address technical issues and security threats</li>
        </ul>

        <h2>4. Data Sharing &amp; Disclosure</h2>
        <p>We do not sell your personal information. We may share information only in the following circumstances:</p>
        <ul style="margin: 12px 0 16px 24px; color: #4b5563; line-height: 1.8; font-size: 0.95em;">
            <li><strong>With your organization:</strong> Administrators may access usage data and content associated with organizational accounts.</li>
            <li><strong>Service providers:</strong> We use third-party providers for hosting (AWS), email delivery, and analytics, subject to data processing agreements.</li>
            <li><strong>Legal requirements:</strong> We may disclose information if required by law, court order, or governmental authority.</li>
        </ul>

        <h2>5. Data Security</h2>
        <p>We implement industry-standard security measures including 256-bit AES encryption at rest and in transit, regular penetration testing, SOC 2 Type II compliance, and role-based access controls. All data is hosted in AWS data centers in the United States with geographic redundancy.</p>

        <h2>6. Data Retention</h2>
        <p>We retain account data for as long as your account is active. Upon account deletion, we remove personal data within 30 days, except where retention is required by law or legitimate business purposes (e.g., audit trails). Anonymized usage statistics may be retained indefinitely.</p>

        <h2>7. Your Rights</h2>
        <p>Depending on your jurisdiction, you may have rights to access, correct, delete, or export your personal data. To exercise these rights, contact us at privacy@3kbusinessservices.com. We respond to all requests within 30 days.</p>

        <h2>8. International Transfers</h2>
        <p>If you access the Services from outside the United States, your information may be transferred to and processed in the United States. We rely on Standard Contractual Clauses and other approved mechanisms for international data transfers in compliance with GDPR.</p>

        <h2>9. Children's Privacy</h2>
        <p>The Services are not directed to individuals under 16 years of age. We do not knowingly collect personal information from children.</p>

        <h2>10. Changes to This Policy</h2>
        <p>We may update this Privacy Policy from time to time. We will notify registered users of material changes via email or in-platform notification at least 30 days before they take effect.</p>

        <h2>11. Contact Us</h2>
        <p>If you have questions about this Privacy Policy, contact our Data Protection Officer:</p>
        <p style="margin-top: 8px;">
            3K Business Services, LLC<br>
            Attn: Data Protection Officer<br>
            8500 Shoal Creek Blvd, Suite 4C<br>
            Austin, TX 78757<br>
            privacy@3kbusinessservices.com
        </p>
    </div>
</div>

<?php stealth_footer(); ?>

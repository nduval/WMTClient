<?php
require_once __DIR__ . '/includes/stealth_layout.php';
stealth_guard();
stealth_header('Contact Us', 'contact');
?>
</head>
<body>
<?php stealth_nav('contact'); ?>

<div class="s-page">
    <div class="s-page-hero">
        <h1>Get in Touch</h1>
        <p>Have questions about our platform? Our team is here to help you find the right solution for your organization.</p>
    </div>

    <div class="s-section" style="max-width: 1100px;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 50px;">

            <!-- Contact Form -->
            <div>
                <h2>Send us a message</h2>
                <p>Fill out the form below and a member of our team will respond within one business day.</p>
                <form style="margin-top: 24px;" onsubmit="event.preventDefault(); document.getElementById('contact-success').style.display='block'; this.reset();">
                    <div class="s-form-group" style="margin-bottom: 18px;">
                        <label style="display: block; margin-bottom: 6px; color: #374151; font-size: 0.85em; font-weight: 600;">Full Name</label>
                        <input type="text" required placeholder="John Smith" style="width: 100%; padding: 11px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; font-size: 0.95em;">
                    </div>
                    <div style="margin-bottom: 18px;">
                        <label style="display: block; margin-bottom: 6px; color: #374151; font-size: 0.85em; font-weight: 600;">Work Email</label>
                        <input type="email" required placeholder="john@company.com" style="width: 100%; padding: 11px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; font-size: 0.95em;">
                    </div>
                    <div style="margin-bottom: 18px;">
                        <label style="display: block; margin-bottom: 6px; color: #374151; font-size: 0.85em; font-weight: 600;">Company</label>
                        <input type="text" placeholder="Acme Corp" style="width: 100%; padding: 11px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; font-size: 0.95em;">
                    </div>
                    <div style="margin-bottom: 18px;">
                        <label style="display: block; margin-bottom: 6px; color: #374151; font-size: 0.85em; font-weight: 600;">How can we help?</label>
                        <select style="width: 100%; padding: 11px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; font-size: 0.95em; color: #333;">
                            <option>General Inquiry</option>
                            <option>Request a Demo</option>
                            <option>Technical Support</option>
                            <option>Partnership</option>
                            <option>Billing Question</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 24px;">
                        <label style="display: block; margin-bottom: 6px; color: #374151; font-size: 0.85em; font-weight: 600;">Message</label>
                        <textarea rows="4" placeholder="Tell us about your needs..." style="width: 100%; padding: 11px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; font-size: 0.95em; resize: vertical; font-family: inherit;"></textarea>
                    </div>
                    <button type="submit" style="width: 100%; padding: 12px; border: none; border-radius: 6px; background: #1a56db; color: #fff; font-size: 0.95em; font-weight: 600; cursor: pointer;">Send Message</button>
                    <div id="contact-success" style="display: none; margin-top: 16px; padding: 12px; background: #ecfdf5; border: 1px solid #6ee7b7; color: #065f46; border-radius: 6px; font-size: 0.88em;">Thank you! We'll be in touch within 24 hours.</div>
                </form>
            </div>

            <!-- Contact Info -->
            <div>
                <h2>Other ways to reach us</h2>
                <p style="margin-bottom: 30px;">We're available Monday through Friday, 8am&ndash;6pm CT.</p>

                <div style="margin-bottom: 28px;">
                    <h3 style="font-size: 0.95em; color: #1e3a5f; margin-bottom: 8px;">📧 Email</h3>
                    <p style="margin-bottom: 4px;">General: <a href="#">info@3kbusinessservices.com</a></p>
                    <p>Support: <a href="#">support@3kbusinessservices.com</a></p>
                </div>

                <div style="margin-bottom: 28px;">
                    <h3 style="font-size: 0.95em; color: #1e3a5f; margin-bottom: 8px;">📞 Phone</h3>
                    <p style="margin-bottom: 4px;">Sales: (512) 555-0147</p>
                    <p>Support: (512) 555-0192</p>
                </div>

                <div style="margin-bottom: 28px;">
                    <h3 style="font-size: 0.95em; color: #1e3a5f; margin-bottom: 8px;">🏢 Headquarters</h3>
                    <p>3K Business Services, LLC<br>
                    8500 Shoal Creek Blvd, Suite 4C<br>
                    Austin, TX 78757<br>
                    United States</p>
                </div>

                <div style="margin-bottom: 28px;">
                    <h3 style="font-size: 0.95em; color: #1e3a5f; margin-bottom: 8px;">🌍 Regional Offices</h3>
                    <p style="margin-bottom: 8px;"><strong>New York</strong><br>
                    285 Madison Ave, 3rd Floor<br>
                    New York, NY 10017</p>
                    <p><strong>London</strong><br>
                    71&ndash;75 Shelton Street<br>
                    London WC2H 9JQ, UK</p>
                </div>
            </div>
        </div>
    </div>
</div>

<?php stealth_footer(); ?>

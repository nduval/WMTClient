<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="3K Business Services provides enterprise knowledge management, workforce training solutions, and real-time analytics for modern organizations.">
    <meta name="keywords" content="business services, enterprise solutions, knowledge management, workforce training, analytics, compliance, professional development">
    <meta name="author" content="3K Business Services">
    <meta name="robots" content="index, follow">
    <meta property="og:title" content="3K Business Services - Enterprise Resource Portal">
    <meta property="og:description" content="Streamline your organization's knowledge management and professional development with our integrated enterprise platform.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://3kbusinessservices.com">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📊</text></svg>">
    <title>3K Business Services - Enterprise Resource Portal</title>
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

        /* ---- NAV BAR ---- */
        .s-nav {
            background: #fff;
            border-bottom: 1px solid #e0e0e0;
            padding: 0 40px;
            height: 60px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 1px 3px rgba(0,0,0,0.06);
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
        }
        .s-nav-links a:hover { color: #1a56db; }
        .s-nav-links .s-nav-cta {
            background: #1a56db;
            color: #fff;
            padding: 8px 18px;
            border-radius: 6px;
            font-weight: 600;
            transition: background 0.2s;
        }
        .s-nav-links .s-nav-cta:hover { background: #1648b8; color: #fff; }

        /* ---- MAIN LAYOUT ---- */
        .s-main {
            flex: 1;
            display: flex;
            align-items: stretch;
            min-height: calc(100vh - 60px - 50px);
        }

        /* ---- LEFT HERO ---- */
        .s-hero {
            flex: 1;
            background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
            color: #fff;
            display: flex;
            flex-direction: column;
            justify-content: center;
            padding: 60px 50px;
            position: relative;
            overflow: hidden;
        }
        .s-hero::before {
            content: '';
            position: absolute;
            top: -50%;
            right: -20%;
            width: 600px;
            height: 600px;
            background: radial-gradient(circle, rgba(255,255,255,0.06) 0%, transparent 70%);
            border-radius: 50%;
        }
        .s-hero::after {
            content: '';
            position: absolute;
            bottom: -30%;
            left: -10%;
            width: 400px;
            height: 400px;
            background: radial-gradient(circle, rgba(255,255,255,0.04) 0%, transparent 70%);
            border-radius: 50%;
        }
        .s-hero > * { position: relative; z-index: 1; }
        .s-hero h1 {
            font-size: 2.2em;
            font-weight: 700;
            line-height: 1.3;
            margin-bottom: 16px;
        }
        .s-hero p.s-hero-sub {
            font-size: 1.05em;
            color: rgba(255,255,255,0.8);
            line-height: 1.6;
            margin-bottom: 40px;
            max-width: 440px;
        }

        /* Stats row */
        .s-stats {
            display: flex;
            gap: 36px;
            margin-bottom: 40px;
        }
        .s-stat-num {
            font-size: 1.8em;
            font-weight: 700;
        }
        .s-stat-label {
            font-size: 0.8em;
            color: rgba(255,255,255,0.65);
            margin-top: 2px;
        }

        /* Feature list */
        .s-features { list-style: none; display: flex; flex-direction: column; gap: 14px; }
        .s-features li {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.92em;
            color: rgba(255,255,255,0.9);
        }
        .s-features li .s-check {
            width: 20px;
            height: 20px;
            background: rgba(255,255,255,0.15);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 0.7em;
        }

        /* Testimonial */
        .s-testimonial {
            margin-top: 40px;
            padding: 20px 24px;
            background: rgba(255,255,255,0.08);
            border-radius: 10px;
            border-left: 3px solid rgba(255,255,255,0.3);
        }
        .s-testimonial p {
            font-size: 0.88em;
            font-style: italic;
            color: rgba(255,255,255,0.85);
            line-height: 1.6;
            margin-bottom: 10px;
        }
        .s-testimonial .s-testimonial-author {
            font-size: 0.78em;
            color: rgba(255,255,255,0.5);
            font-style: normal;
        }

        /* ---- RIGHT LOGIN ---- */
        .s-login-side {
            width: 480px;
            min-width: 420px;
            background: #fff;
            display: flex;
            flex-direction: column;
            justify-content: center;
            padding: 50px 50px;
            border-left: 1px solid #e5e7eb;
        }
        .s-login-header {
            margin-bottom: 8px;
        }
        .s-login-header h2 {
            font-size: 1.5em;
            color: #1e3a5f;
            font-weight: 700;
        }
        .s-login-header p {
            color: #6b7280;
            font-size: 0.88em;
            margin-top: 6px;
            margin-bottom: 24px;
        }

        /* Tabs */
        .s-tabs {
            display: flex;
            margin-bottom: 24px;
            border-bottom: 1px solid #e5e7eb;
        }
        .s-tab {
            flex: 1;
            padding: 10px 0;
            text-align: center;
            cursor: pointer;
            border: none;
            background: transparent;
            color: #9ca3af;
            font-size: 0.88em;
            font-weight: 500;
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
            transition: all 0.2s;
        }
        .s-tab:hover { color: #1e3a5f; }
        .s-tab.active { color: #1a56db; border-bottom-color: #1a56db; }

        /* Form styles */
        .s-form { display: none; }
        .s-form.active { display: block; }

        .s-form-group { margin-bottom: 18px; }
        .s-form-group label {
            display: block;
            margin-bottom: 6px;
            color: #374151;
            font-size: 0.85em;
            font-weight: 600;
        }
        .s-form-group input {
            width: 100%;
            padding: 11px 14px;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            background: #f9fafb;
            color: #333;
            font-size: 0.95em;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .s-form-group input:focus {
            outline: none;
            border-color: #1a56db;
            box-shadow: 0 0 0 3px rgba(26,86,219,0.1);
        }
        .s-form-hint {
            display: block;
            color: #9ca3af;
            font-size: 0.75em;
            margin-top: 4px;
        }

        .s-btn {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 6px;
            background: #1a56db;
            color: #fff;
            font-size: 0.95em;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s, transform 0.1s;
        }
        .s-btn:hover { background: #1648b8; }
        .s-btn:active { transform: scale(0.99); }
        .s-btn:disabled { background: #9ca3af; cursor: not-allowed; transform: none; }

        .s-error {
            background: #fef2f2;
            border: 1px solid #fca5a5;
            color: #b91c1c;
            padding: 10px 14px;
            border-radius: 6px;
            margin-bottom: 16px;
            display: none;
            font-size: 0.88em;
        }
        .s-success {
            background: #ecfdf5;
            border: 1px solid #6ee7b7;
            color: #065f46;
            padding: 10px 14px;
            border-radius: 6px;
            margin-bottom: 16px;
            display: none;
            font-size: 0.88em;
        }

        .s-forgot-text {
            color: #6b7280;
            margin-bottom: 18px;
            font-size: 0.85em;
            line-height: 1.5;
        }

        .s-divider {
            border-top: 1px solid #e5e7eb;
            margin: 24px 0 16px;
        }
        .s-login-footer {
            color: #9ca3af;
            font-size: 0.72em;
            text-align: center;
            line-height: 1.5;
        }

        /* ---- FOOTER BAR ---- */
        .s-footer {
            background: #fff;
            border-top: 1px solid #e0e0e0;
            padding: 14px 40px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 0.75em;
            color: #9ca3af;
        }
        .s-footer a {
            color: #6b7280;
            text-decoration: none;
            margin-left: 20px;
        }
        .s-footer a:hover { color: #1a56db; }

        /* ---- RESPONSIVE ---- */
        @media (max-width: 900px) {
            .s-main { flex-direction: column; }
            .s-hero { padding: 40px 30px; min-height: auto; }
            .s-hero h1 { font-size: 1.6em; }
            .s-stats { gap: 24px; }
            .s-stat-num { font-size: 1.4em; }
            .s-testimonial { display: none; }
            .s-login-side {
                width: 100%;
                min-width: auto;
                padding: 30px;
                border-left: none;
                border-top: 1px solid #e5e7eb;
            }
            .s-nav-links a:not(.s-nav-cta) { display: none; }
        }
    </style>
</head>
<body>

<!-- Navigation -->
<nav class="s-nav">
    <a href="#" class="s-nav-brand">
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="6" fill="#1e3a5f"/>
            <text x="4" y="23" font-family="Segoe UI,sans-serif" font-weight="700" font-size="16" fill="#fff">3K</text>
        </svg>
        <span>3K Business Services</span>
    </a>
    <div class="s-nav-links">
        <a href="#">Solutions</a>
        <a href="#">Resources</a>
        <a href="#">Pricing</a>
        <a href="#">Contact</a>
        <a href="#" class="s-nav-cta" onclick="return false;">Request Demo</a>
    </div>
</nav>

<!-- Main Content -->
<div class="s-main">

    <!-- Left Hero -->
    <div class="s-hero">
        <h1>Enterprise Knowledge<br>Management Platform</h1>
        <p class="s-hero-sub">Centralize your organization's training resources, track compliance, and accelerate professional development with our integrated business intelligence suite.</p>

        <div class="s-stats">
            <div>
                <div class="s-stat-num">500+</div>
                <div class="s-stat-label">Organizations</div>
            </div>
            <div>
                <div class="s-stat-num">99.9%</div>
                <div class="s-stat-label">Uptime SLA</div>
            </div>
            <div>
                <div class="s-stat-num">24/7</div>
                <div class="s-stat-label">Support</div>
            </div>
        </div>

        <ul class="s-features">
            <li><span class="s-check">&#10003;</span>Role-based access control &amp; SSO integration</li>
            <li><span class="s-check">&#10003;</span>Real-time dashboards &amp; custom reporting</li>
            <li><span class="s-check">&#10003;</span>Automated compliance tracking &amp; audit trails</li>
            <li><span class="s-check">&#10003;</span>API-first architecture for seamless integration</li>
        </ul>

        <div class="s-testimonial">
            <p>"3K Business Services transformed how we manage training across 12 regional offices. The analytics alone saved us 200+ hours per quarter."</p>
            <div class="s-testimonial-author">&mdash; Sarah Chen, VP of Operations, Meridian Group</div>
        </div>
    </div>

    <!-- Right Login -->
    <div class="s-login-side">
        <div class="s-login-header">
            <h2>Sign in to your account</h2>
            <p>Access your organization's resource portal</p>
        </div>

        <div class="s-tabs">
            <button class="s-tab active" data-tab="login">Sign In</button>
            <button class="s-tab" data-tab="register">Create Account</button>
            <button class="s-tab" data-tab="forgot">Reset Password</button>
        </div>

        <div id="login-form" class="s-form active">
            <div class="s-error" id="login-error"></div>
            <form id="loginForm">
                <div class="s-form-group">
                    <label for="login-username">Username</label>
                    <input type="text" id="login-username" name="username" required autocomplete="username" placeholder="Enter your username">
                </div>
                <div class="s-form-group">
                    <label for="login-password">Password</label>
                    <input type="password" id="login-password" name="password" required autocomplete="current-password" placeholder="Enter your password">
                </div>
                <button type="submit" class="s-btn" id="login-btn">Sign In</button>
            </form>
        </div>

        <div id="register-form" class="s-form">
            <div class="s-error" id="register-error"></div>
            <div class="s-success" id="register-success"></div>
            <form id="registerForm">
                <div class="s-form-group">
                    <label for="register-username">Username</label>
                    <input type="text" id="register-username" name="username" required autocomplete="username" minlength="3" maxlength="30" pattern="[a-zA-Z0-9_]+" placeholder="Choose a username">
                </div>
                <div class="s-form-group">
                    <label for="register-email">Work Email</label>
                    <input type="email" id="register-email" name="email" required autocomplete="email" placeholder="you@company.com">
                    <small class="s-form-hint">Used for account recovery only.</small>
                </div>
                <div class="s-form-group">
                    <label for="register-password">Password</label>
                    <input type="password" id="register-password" name="password" required autocomplete="new-password" minlength="6" placeholder="Create a password">
                </div>
                <div class="s-form-group">
                    <label for="register-confirm">Confirm Password</label>
                    <input type="password" id="register-confirm" name="confirm" required autocomplete="new-password" placeholder="Confirm your password">
                </div>
                <button type="submit" class="s-btn" id="register-btn">Create Account</button>
            </form>
        </div>

        <div id="forgot-form" class="s-form">
            <div class="s-error" id="forgot-error"></div>
            <div class="s-success" id="forgot-success"></div>
            <form id="forgotForm">
                <p class="s-forgot-text">Enter the email address associated with your account and we'll send you a secure link to reset your password.</p>
                <div class="s-form-group">
                    <label for="forgot-email">Email Address</label>
                    <input type="email" id="forgot-email" name="email" required autocomplete="email" placeholder="you@company.com">
                </div>
                <button type="submit" class="s-btn" id="forgot-btn">Send Reset Link</button>
            </form>
        </div>

        <div class="s-divider"></div>
        <div class="s-login-footer">
            Protected by 256-bit SSL encryption.<br>
            By signing in, you agree to our Terms of Service and Privacy Policy.
        </div>
    </div>
</div>

<!-- Footer -->
<footer class="s-footer">
    <div>&copy; 2024&ndash;2026 3K Business Services, LLC. All rights reserved.</div>
    <div>
        <a href="#">Privacy Policy</a>
        <a href="#">Terms of Service</a>
        <a href="#">Status</a>
        <a href="#">Support</a>
    </div>
</footer>

<script>
    // Tab switching
    document.querySelectorAll('.s-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.s-form').forEach(f => f.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab + '-form').classList.add('active');
        });
    });

    // Login form
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('login-btn');
        const error = document.getElementById('login-error');
        btn.disabled = true;
        btn.textContent = 'Signing in...';
        error.style.display = 'none';
        try {
            const response = await fetch('api/auth.php?action=login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('login-username').value,
                    password: document.getElementById('login-password').value
                })
            });
            const data = await response.json();
            if (data.success) {
                window.location.href = 'characters.php';
            } else {
                error.textContent = data.error || 'Authentication failed';
                error.style.display = 'block';
            }
        } catch (err) {
            error.textContent = 'Connection error: ' + err.message;
            error.style.display = 'block';
        }
        btn.disabled = false;
        btn.textContent = 'Sign In';
    });

    // Register form
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('register-btn');
        const error = document.getElementById('register-error');
        const success = document.getElementById('register-success');
        const password = document.getElementById('register-password').value;
        const confirm = document.getElementById('register-confirm').value;
        if (password !== confirm) {
            error.textContent = 'Passwords do not match';
            error.style.display = 'block';
            return;
        }
        btn.disabled = true;
        btn.textContent = 'Creating account...';
        error.style.display = 'none';
        success.style.display = 'none';
        try {
            const response = await fetch('api/auth.php?action=register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('register-username').value,
                    email: document.getElementById('register-email').value,
                    password: password
                })
            });
            const data = await response.json();
            if (data.success) {
                window.location.href = 'characters.php';
            } else {
                error.textContent = data.error;
                error.style.display = 'block';
            }
        } catch (err) {
            error.textContent = 'Connection error. Please try again.';
            error.style.display = 'block';
        }
        btn.disabled = false;
        btn.textContent = 'Create Account';
    });

    // Forgot password form
    document.getElementById('forgotForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('forgot-btn');
        const error = document.getElementById('forgot-error');
        const success = document.getElementById('forgot-success');
        btn.disabled = true;
        btn.textContent = 'Sending...';
        error.style.display = 'none';
        success.style.display = 'none';
        try {
            const response = await fetch('api/auth.php?action=forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: document.getElementById('forgot-email').value
                })
            });
            const data = await response.json();
            if (data.success) {
                success.textContent = data.message;
                success.style.display = 'block';
                document.getElementById('forgotForm').reset();
            } else {
                error.textContent = data.error || 'Failed to send reset link';
                error.style.display = 'block';
            }
        } catch (err) {
            error.textContent = 'Connection error. Please try again.';
            error.style.display = 'block';
        }
        btn.disabled = false;
        btn.textContent = 'Send Reset Link';
    });
</script>
</body>
</html>

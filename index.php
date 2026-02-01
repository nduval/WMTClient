<?php
/**
 * WMT Client - Login/Register Page
 */

require_once __DIR__ . '/includes/auth.php';

// Redirect if already logged in
if (isLoggedIn()) {
    header('Location: characters.php');
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
    <title><?= APP_NAME ?> - Login</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
        }

        .container {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        .logo {
            text-align: center;
            margin-bottom: 30px;
        }

        .logo h1 {
            font-size: 2.5em;
            color: #00ff00;
            text-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
        }

        .logo p {
            color: #888;
            font-size: 0.9em;
            margin-top: 5px;
        }

        .tabs {
            display: flex;
            margin-bottom: 30px;
        }

        .tab {
            flex: 1;
            padding: 12px;
            text-align: center;
            cursor: pointer;
            border: none;
            background: transparent;
            color: #888;
            font-size: 1em;
            border-bottom: 2px solid transparent;
            transition: all 0.3s;
        }

        .tab:hover {
            color: #fff;
        }

        .tab.active {
            color: #00ff00;
            border-bottom-color: #00ff00;
        }

        .form-container {
            display: none;
        }

        .form-container.active {
            display: block;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            color: #ccc;
        }

        .form-group input {
            width: 100%;
            padding: 12px 15px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            background: rgba(0, 0, 0, 0.3);
            color: #fff;
            font-size: 1em;
            transition: border-color 0.3s;
        }

        .form-group input:focus {
            outline: none;
            border-color: #00ff00;
        }

        .btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 8px;
            background: #00ff00;
            color: #000;
            font-size: 1em;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
        }

        .btn:hover {
            background: #00cc00;
            transform: translateY(-2px);
        }

        .btn:disabled {
            background: #666;
            cursor: not-allowed;
            transform: none;
        }

        .error-message {
            background: rgba(255, 0, 0, 0.2);
            border: 1px solid #ff0000;
            color: #ff6666;
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: none;
        }

        .success-message {
            background: rgba(0, 255, 0, 0.2);
            border: 1px solid #00ff00;
            color: #00ff00;
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: none;
        }

        .support-link {
            text-align: center;
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .support-link a {
            color: #888;
            text-decoration: none;
            font-size: 0.85em;
            transition: color 0.3s;
        }

        .support-link a:hover {
            color: #ffdd00;
        }

        .guest-section {
            text-align: center;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .guest-section p.guest-label {
            color: #888;
            font-size: 0.85em;
            margin-bottom: 10px;
        }

        .guest-links {
            display: flex;
            gap: 12px;
            justify-content: center;
            margin-bottom: 10px;
        }

        .guest-links a {
            color: #00ff00;
            text-decoration: none;
            font-size: 0.9em;
            padding: 6px 14px;
            border: 1px solid rgba(0, 255, 0, 0.3);
            border-radius: 6px;
            transition: all 0.3s;
        }

        .guest-links a:hover {
            background: rgba(0, 255, 0, 0.1);
            border-color: #00ff00;
        }

        .guest-section p.guest-note {
            color: #666;
            font-size: 0.75em;
            line-height: 1.4;
            max-width: 340px;
            margin: 0 auto;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <h1><?= APP_NAME ?></h1>
            <p>MUD Client for 3k.org</p>
        </div>

        <div class="tabs">
            <button class="tab active" data-tab="login">Login</button>
            <button class="tab" data-tab="register">Register</button>
            <button class="tab" data-tab="forgot">Forgot Password</button>
        </div>

        <div id="login-form" class="form-container active">
            <div class="error-message" id="login-error"></div>
            <form id="loginForm">
                <div class="form-group">
                    <label for="login-username">Username</label>
                    <input type="text" id="login-username" name="username" required autocomplete="username">
                </div>
                <div class="form-group">
                    <label for="login-password">Password</label>
                    <input type="password" id="login-password" name="password" required autocomplete="current-password">
                </div>
                <button type="submit" class="btn" id="login-btn">Login</button>
            </form>
        </div>

        <div id="register-form" class="form-container">
            <div class="error-message" id="register-error"></div>
            <div class="success-message" id="register-success"></div>
            <form id="registerForm">
                <div class="form-group">
                    <label for="register-username">Username</label>
                    <input type="text" id="register-username" name="username" required autocomplete="username" minlength="3" maxlength="30" pattern="[a-zA-Z0-9_]+">
                </div>
                <div class="form-group">
                    <label for="register-email">Email</label>
                    <input type="email" id="register-email" name="email" required autocomplete="email">
                    <small class="form-hint">Only used for password recovery.</small>
                </div>
                <div class="form-group">
                    <label for="register-password">Password</label>
                    <input type="password" id="register-password" name="password" required autocomplete="new-password" minlength="6">
                </div>
                <div class="form-group">
                    <label for="register-confirm">Confirm Password</label>
                    <input type="password" id="register-confirm" name="confirm" required autocomplete="new-password">
                </div>
                <button type="submit" class="btn" id="register-btn">Create Account</button>
            </form>
        </div>

        <div id="forgot-form" class="form-container">
            <div class="error-message" id="forgot-error"></div>
            <div class="success-message" id="forgot-success"></div>
            <form id="forgotForm">
                <p style="color: #888; margin-bottom: 20px; font-size: 0.9em;">Enter your email address and we'll send you a link to reset your password.</p>
                <div class="form-group">
                    <label for="forgot-email">Email</label>
                    <input type="email" id="forgot-email" name="email" required autocomplete="email">
                </div>
                <button type="submit" class="btn" id="forgot-btn">Send Reset Link</button>
            </form>
        </div>

        <div class="guest-section">
            <p class="guest-label">Or try it without an account:</p>
            <div class="guest-links">
                <a href="guest.php?server=3k">Guest on 3Kingdoms</a>
                <a href="guest.php?server=3s">Guest on 3Scapes</a>
            </div>
            <p class="guest-note">Guest accounts are very limited, but can move around town, look at things, and get a feel for the MUD. They do not save, and cannot interact with other players.</p>
        </div>

        <div class="support-link">
            <a href="https://buymeacoffee.com/wemudtogether" target="_blank" rel="noopener">Support this project</a>
        </div>
    </div>

    <script>
        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.form-container').forEach(f => f.classList.remove('active'));
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
            btn.textContent = 'Logging in...';
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
                    error.textContent = data.error || 'Login failed';
                    error.style.display = 'block';
                }
            } catch (err) {
                error.textContent = 'Connection error: ' + err.message;
                error.style.display = 'block';
            }

            btn.disabled = false;
            btn.textContent = 'Login';
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

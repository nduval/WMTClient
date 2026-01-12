<?php
/**
 * WMT Client - Password Reset Page
 */

require_once __DIR__ . '/includes/auth.php';

initSession();

// Redirect if already logged in
if (isLoggedIn()) {
    header('Location: characters.php');
    exit;
}

$token = $_GET['token'] ?? '';
$error = '';
$validToken = false;
$username = '';

if (!empty($token)) {
    $user = validatePasswordResetToken($token);
    if ($user) {
        $validToken = true;
        $username = $user['username'];
    } else {
        $error = 'This password reset link is invalid or has expired.';
    }
} else {
    $error = 'No reset token provided.';
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
    <title>Reset Password - <?= APP_NAME ?></title>
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
            font-size: 2em;
            color: #00ff00;
            text-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
        }

        .logo p {
            color: #888;
            font-size: 0.9em;
            margin-top: 5px;
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
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }

        .success-message {
            background: rgba(0, 255, 0, 0.2);
            border: 1px solid #00ff00;
            color: #00ff00;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }

        .back-link {
            text-align: center;
            margin-top: 20px;
        }

        .back-link a {
            color: #00ff00;
            text-decoration: none;
        }

        .back-link a:hover {
            text-decoration: underline;
        }

        .username-display {
            text-align: center;
            color: #888;
            margin-bottom: 20px;
        }

        .username-display strong {
            color: #00ff00;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <h1><?= APP_NAME ?></h1>
            <p>Reset Password</p>
        </div>

        <?php if (!$validToken): ?>
            <div class="error-message"><?= htmlspecialchars($error) ?></div>
            <div class="back-link">
                <a href="index.php">Back to Login</a>
            </div>
        <?php else: ?>
            <div class="username-display">
                Resetting password for <strong><?= htmlspecialchars($username) ?></strong>
            </div>

            <div class="error-message" id="reset-error" style="display: none;"></div>
            <div class="success-message" id="reset-success" style="display: none;"></div>

            <form id="resetForm">
                <input type="hidden" id="reset-token" value="<?= htmlspecialchars($token) ?>">
                <div class="form-group">
                    <label for="new-password">New Password</label>
                    <input type="password" id="new-password" name="password" required autocomplete="new-password" minlength="6">
                </div>
                <div class="form-group">
                    <label for="confirm-password">Confirm New Password</label>
                    <input type="password" id="confirm-password" name="confirm" required autocomplete="new-password">
                </div>
                <button type="submit" class="btn" id="reset-btn">Reset Password</button>
            </form>

            <div class="back-link">
                <a href="index.php">Back to Login</a>
            </div>
        <?php endif; ?>
    </div>

    <?php if ($validToken): ?>
    <script>
        document.getElementById('resetForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('reset-btn');
            const error = document.getElementById('reset-error');
            const success = document.getElementById('reset-success');

            const password = document.getElementById('new-password').value;
            const confirm = document.getElementById('confirm-password').value;

            if (password !== confirm) {
                error.textContent = 'Passwords do not match';
                error.style.display = 'block';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Resetting...';
            error.style.display = 'none';
            success.style.display = 'none';

            try {
                const response = await fetch('api/auth.php?action=reset-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: document.getElementById('reset-token').value,
                        password: password
                    })
                });

                const data = await response.json();

                if (data.success) {
                    success.textContent = data.message;
                    success.style.display = 'block';
                    document.getElementById('resetForm').style.display = 'none';
                    setTimeout(() => {
                        window.location.href = 'index.php';
                    }, 2000);
                } else {
                    error.textContent = data.error || 'Failed to reset password';
                    error.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Reset Password';
                }
            } catch (err) {
                error.textContent = 'Connection error. Please try again.';
                error.style.display = 'block';
                btn.disabled = false;
                btn.textContent = 'Reset Password';
            }
        });
    </script>
    <?php endif; ?>
</body>
</html>

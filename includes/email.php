<?php
/**
 * WMT Client - Email Functions (SendGrid)
 */

require_once __DIR__ . '/../config/sendgrid.php';

/**
 * Send an email via SendGrid API
 */
function sendEmail(string $toEmail, string $toName, string $subject, string $htmlBody, string $textBody = '', string $bccEmail = ''): array {
    $apiKey = SENDGRID_API_KEY;

    if ($apiKey === 'YOUR_API_KEY_HERE' || empty($apiKey)) {
        error_log("sendEmail: SendGrid API key not configured");
        return ['success' => false, 'error' => 'Email not configured'];
    }

    // If no text body provided, strip HTML
    if (empty($textBody)) {
        $textBody = strip_tags($htmlBody);
    }

    $personalization = [
        'to' => [
            ['email' => $toEmail, 'name' => $toName]
        ],
        'subject' => $subject
    ];

    // Add BCC if provided
    if (!empty($bccEmail)) {
        $personalization['bcc'] = [
            ['email' => $bccEmail]
        ];
    }

    $data = [
        'personalizations' => [$personalization],
        'from' => [
            'email' => EMAIL_FROM_ADDRESS,
            'name' => EMAIL_FROM_NAME
        ],
        'content' => [
            ['type' => 'text/plain', 'value' => $textBody],
            ['type' => 'text/html', 'value' => $htmlBody]
        ]
    ];

    $ch = curl_init('https://api.sendgrid.com/v3/mail/send');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($data),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $apiKey,
            'Content-Type: application/json'
        ]
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($error) {
        error_log("sendEmail: cURL error - $error");
        return ['success' => false, 'error' => 'Failed to connect to email service'];
    }

    // SendGrid returns 202 for successful send
    if ($httpCode === 202) {
        return ['success' => true];
    }

    error_log("sendEmail: SendGrid returned $httpCode - $response");
    return ['success' => false, 'error' => 'Email service error'];
}

/**
 * Send password reset email
 */
function sendPasswordResetEmail(string $email, string $username, string $resetToken, string $baseUrl, string $bccEmail = ''): array {
    $resetLink = $baseUrl . '/reset-password.php?token=' . urlencode($resetToken);

    $subject = 'Password Reset Request - ' . APP_NAME;

    $htmlBody = '
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; padding: 20px; text-align: center;">
            <h1 style="color: #00ff00; margin: 0;">' . htmlspecialchars(APP_NAME) . '</h1>
        </div>
        <div style="background: #f5f5f5; padding: 30px;">
            <h2 style="color: #333;">Password Reset Request</h2>
            <p style="color: #555;">Hi ' . htmlspecialchars($username) . ',</p>
            <p style="color: #555;">We received a request to reset your password. Click the button below to create a new password:</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="' . htmlspecialchars($resetLink) . '" style="background: #00ff00; color: #000; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
            </p>
            <p style="color: #555;">Or copy and paste this link into your browser:</p>
            <p style="color: #0066cc; word-break: break-all;">' . htmlspecialchars($resetLink) . '</p>
            <p style="color: #888; font-size: 12px; margin-top: 30px;">This link will expire in 1 hour. If you didn\'t request this reset, you can safely ignore this email.</p>
        </div>
        <div style="background: #1a1a2e; padding: 15px; text-align: center;">
            <p style="color: #888; font-size: 12px; margin: 0;">MUD Client for 3k.org</p>
        </div>
    </div>';

    $textBody = "Hi $username,\n\n";
    $textBody .= "We received a request to reset your password.\n\n";
    $textBody .= "Click this link to reset your password:\n$resetLink\n\n";
    $textBody .= "This link will expire in 1 hour.\n\n";
    $textBody .= "If you didn't request this reset, you can safely ignore this email.";

    return sendEmail($email, $username, $subject, $htmlBody, $textBody, $bccEmail);
}

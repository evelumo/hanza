<?php
// Creates the REST API keys of the sandbox and prints them as one line of JSON (`sandbox.sh key` writes the file).
// Earlier sandbox keys are replaced. Arguments: the sandbox's local origin.

// Dev tooling that changes settings, creates data and prints API keys: it must never run on a shop that is not the
// sandbox. The sandbox installs itself under this neutral address (sandbox.sh, README.md).
if (rtrim((string) get_option('home'), '/') !== 'https://shop.example.test') {
    WP_CLI::error('Refusing to run: this site is not the Hanza sandbox (its home URL is not https://shop.example.test).');
}

global $wpdb;

$sandbox_url = $args[0] ?? '';
if ($sandbox_url === '') {
    WP_CLI::error('Usage: wp eval-file key.php <local origin>');
}

// A user who may sign in but not manage the shop: its key answers 403 on every wc/v3 route.
$subscriber = get_user_by('login', 'sandbox-subscriber');
$subscriber_id = $subscriber ? $subscriber->ID : wp_insert_user([
    'user_login' => 'sandbox-subscriber',
    'user_email' => 'sandbox-subscriber@example.test',
    'user_pass' => wp_generate_password(32),
    'role' => 'subscriber',
]);

$wpdb->query("DELETE FROM {$wpdb->prefix}woocommerce_api_keys WHERE description LIKE 'Hanza sandbox%'");

$create = function (string $label, int $user_id, string $permissions) use ($wpdb): array {
    $consumer_key = 'ck_' . wc_rand_hash();
    $consumer_secret = 'cs_' . wc_rand_hash();
    $wpdb->insert($wpdb->prefix . 'woocommerce_api_keys', [
        'user_id' => $user_id,
        'description' => 'Hanza sandbox: ' . $label,
        'permissions' => $permissions,
        'consumer_key' => wc_api_hash($consumer_key),
        'consumer_secret' => $consumer_secret,
        'truncated_key' => substr($consumer_key, -7),
    ]);
    return ['consumerKey' => $consumer_key, 'consumerSecret' => $consumer_secret];
};

$admin_id = (int) get_users(['role' => 'administrator', 'number' => 1, 'fields' => 'ID'])[0];

echo wp_json_encode(
    [
        'sandboxUrl' => $sandbox_url,
        'storeUrl' => home_url(),
    ]
    + $create('read and write', $admin_id, 'read_write')
    + [
        'readOnly' => $create('read only', $admin_id, 'read'),
        'noCapability' => $create('no capability', (int) $subscriber_id, 'read_write'),
    ],
    JSON_UNESCAPED_SLASHES
) . "\n";

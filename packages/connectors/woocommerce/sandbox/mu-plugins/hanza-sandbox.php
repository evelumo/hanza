<?php
/**
 * Plugin Name: Hanza sandbox
 * Description: Keeps the recording sandbox quiet, and adds one order status a plugin could add.
 */

// Silences all mail on the site it runs on: do nothing anywhere but the sandbox, which installs itself under this
// neutral address (sandbox.sh). Before WordPress is installed there is no address yet, so nothing is done then either.
if (rtrim((string) get_option('home'), '/') !== 'https://shop.example.test') {
    return;
}

// No mail leaves the sandbox: WooCommerce e-mails the Buyer on most status changes.
add_filter('pre_wp_mail', '__return_true');

// A status from outside WooCommerce's own list, as shipping and ERP plugins add them.
add_action('init', function () {
    register_post_status('wc-packing', [
        'label' => 'Packing',
        'public' => true,
        'exclude_from_search' => false,
        'show_in_admin_all_list' => true,
        'show_in_admin_status_list' => true,
    ]);
});
add_filter('wc_order_statuses', function ($statuses) {
    $statuses['wc-packing'] = 'Packing';
    return $statuses;
});

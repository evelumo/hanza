<?php
// Shop settings of the sandbox, run by `sandbox.sh up` through `wp eval-file`. Safe to run again.

// Dev tooling that changes settings, creates data and prints API keys: it must never run on a shop that is not the
// sandbox. The sandbox installs itself under this neutral address (sandbox.sh, README.md).
if (rtrim((string) get_option('home'), '/') !== 'https://shop.example.test') {
    WP_CLI::error('Refusing to run: this site is not the Hanza sandbox (its home URL is not https://shop.example.test).');
}

if (!class_exists('WooCommerce')) {
    WP_CLI::error('WooCommerce is not active.');
}

$options = [
    // Not UTC on purpose: a date filter that confuses site time with UTC is off by one or two hours here.
    'timezone_string' => 'Europe/Warsaw',
    'woocommerce_default_country' => 'PL',
    'woocommerce_currency' => 'PLN',
    'woocommerce_price_num_decimals' => '2',
    'woocommerce_manage_stock' => 'yes',
    // Empty = unpaid orders are never cancelled by WooCommerce, so a `pending` seed order stays pending.
    'woocommerce_hold_stock_minutes' => '',
    'woocommerce_calc_taxes' => 'yes',
    'woocommerce_prices_include_tax' => 'yes',
    'woocommerce_tax_display_shop' => 'incl',
    'woocommerce_tax_display_cart' => 'incl',
    'woocommerce_enable_guest_checkout' => 'yes',
    'woocommerce_coming_soon' => 'no',
    'woocommerce_allow_tracking' => 'no',
    'woocommerce_show_marketplace_suggestions' => 'no',
    'blog_public' => '0',
];
foreach ($options as $name => $value) {
    update_option($name, $value);
}

global $wpdb;
if ((int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}woocommerce_tax_rates") === 0) {
    WC_Tax::_insert_tax_rate([
        'tax_rate_country' => 'PL',
        'tax_rate_state' => '',
        'tax_rate' => '23.0000',
        'tax_rate_name' => 'VAT',
        'tax_rate_priority' => 1,
        'tax_rate_compound' => 0,
        'tax_rate_shipping' => 1,
        'tax_rate_order' => 1,
        'tax_rate_class' => '',
    ]);
}

$hpos = get_option('woocommerce_custom_orders_table_enabled') === 'yes' ? 'on' : 'off';
WP_CLI::success(sprintf(
    'WordPress %s, WooCommerce %s, HPOS %s, timezone %s, currency %s.',
    get_bloginfo('version'),
    WC()->version,
    $hpos,
    wp_timezone_string(),
    get_woocommerce_currency()
));

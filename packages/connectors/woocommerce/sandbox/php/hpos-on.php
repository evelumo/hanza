<?php
// Turns HPOS (the order tables) on where wp-cli has no command for it: WooCommerce 7.6, which `sandbox.sh up` falls
// back to this file for (later versions have `wp wc cot enable`, then `wp wc hpos enable`). Run on an empty shop.

// Dev tooling that changes settings, creates data and prints API keys: it must never run on a shop that is not the
// sandbox. The sandbox installs itself under this neutral address (sandbox.sh, README.md).
if (rtrim((string) get_option('home'), '/') !== 'https://shop.example.test') {
    WP_CLI::error('Refusing to run: this site is not the Hanza sandbox (its home URL is not https://shop.example.test).');
}

if (!class_exists('WooCommerce')) {
    WP_CLI::error('WooCommerce is not active.');
}

$container = wc_get_container();
// The feature first: without it the option below is ignored.
$container->get(\Automattic\WooCommerce\Internal\Features\FeaturesController::class)->change_feature_enable('custom_order_tables', true);
$container->get(\Automattic\WooCommerce\Internal\DataStores\Orders\DataSynchronizer::class)->create_database_tables();
update_option('woocommerce_custom_orders_table_enabled', 'yes');

WP_CLI::success('HPOS on.');

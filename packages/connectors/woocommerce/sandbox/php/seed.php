<?php
// The seed of the sandbox: products and orders that cover what the connector has to map. Run by `sandbox.sh seed`.
// Every person, address, phone number and e-mail below is invented. The order of the calls decides the ids, so
// a fresh shop always gets the same ones: add new things at the end of their section's list, never in the middle.

// Dev tooling that changes settings, creates data and prints API keys: it must never run on a shop that is not the
// sandbox. The sandbox installs itself under this neutral address (sandbox.sh, README.md).
if (rtrim((string) get_option('home'), '/') !== 'https://shop.example.test') {
    WP_CLI::error('Refusing to run: this site is not the Hanza sandbox (its home URL is not https://shop.example.test).');
}

if (!class_exists('WooCommerce')) {
    WP_CLI::error('WooCommerce is not active: run "sandbox.sh up" first.');
}
if (get_option('hanza_sandbox_seeded')) {
    WP_CLI::error('This shop is already seeded: "sandbox.sh reset" gives a fresh one.');
}

// --- Products -------------------------------------------------------------------------------------------------

function hanza_product(WC_Product $product, array $props): int
{
    $product->set_props($props + ['status' => 'publish']);
    return $product->save();
}

function hanza_variable(array $props, array $attributes, array $variations): array
{
    $product = new WC_Product_Variable();
    $product_attributes = [];
    foreach ($attributes as $name => $options) {
        $attribute = new WC_Product_Attribute();
        $attribute->set_name($name);
        $attribute->set_options($options);
        $attribute->set_visible(true);
        $attribute->set_variation(true);
        $product_attributes[] = $attribute;
    }
    $product->set_props($props + ['status' => 'publish']);
    $product->set_attributes($product_attributes);
    $parent_id = $product->save();

    $ids = [];
    foreach ($variations as $key => $variation_props) {
        $variation = new WC_Product_Variation();
        $variation->set_parent_id($parent_id);
        $variation->set_props($variation_props + ['status' => 'publish']);
        $ids[$key] = $variation->save();
    }
    WC_Product_Variable::sync($parent_id);
    return ['parent' => $parent_id] + $ids;
}

$products = [];
$products['mug'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Kubek ceramiczny żółty', 'sku' => 'WOO-MUG-1', 'regular_price' => '49.99',
    'manage_stock' => true, 'stock_quantity' => 100,
]);
$products['notebook'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Notes w kratkę A5', 'sku' => 'WOO-NOTE-1', 'regular_price' => '19.90',
    'manage_stock' => true, 'stock_quantity' => 200,
]);
$products['poster'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Plakat bez SKU', 'regular_price' => '35.00', 'manage_stock' => true, 'stock_quantity' => 12,
]);
$products['candle'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Świeca sojowa', 'sku' => 'WOO-CANDLE-1', 'regular_price' => '59.00', 'manage_stock' => false,
]);
$products['draft'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Szkic produktu', 'sku' => 'WOO-DRAFT-1', 'regular_price' => '10.00', 'status' => 'draft',
    'manage_stock' => true, 'stock_quantity' => 5,
]);
$products['no_price'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Produkt bez ceny', 'sku' => 'WOO-NOPRICE-1', 'manage_stock' => true, 'stock_quantity' => 3,
]);
$products['backpack'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Plecak miejski', 'sku' => 'WOO-BAG-1', 'regular_price' => '129.00', 'sale_price' => '99.00',
    'manage_stock' => true, 'stock_quantity' => 8,
]);
$products['gift_card'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Karta podarunkowa 100 zł', 'sku' => 'WOO-GIFT-100', 'regular_price' => '100.00', 'virtual' => true,
]);
$products['gone'] = hanza_product(new WC_Product_Simple(), [
    'name' => 'Produkt wycofany', 'sku' => 'WOO-GONE-1', 'regular_price' => '15.00',
    'manage_stock' => true, 'stock_quantity' => 4,
]);

// The parent manages stock, so a variation that does not manage its own reports manage_stock "parent".
$tshirt = hanza_variable(
    ['name' => 'Koszulka testowa', 'sku' => 'WOO-TSHIRT', 'manage_stock' => true, 'stock_quantity' => 40],
    ['Rozmiar' => ['S', 'M', 'L', 'XL']],
    [
        's' => ['attributes' => ['rozmiar' => 'S'], 'sku' => 'WOO-TSHIRT-S', 'regular_price' => '79.00', 'manage_stock' => true, 'stock_quantity' => 7],
        // No SKU of its own: the API reports the parent's.
        'm' => ['attributes' => ['rozmiar' => 'M'], 'regular_price' => '79.00', 'manage_stock' => true, 'stock_quantity' => 5],
        'l' => ['attributes' => ['rozmiar' => 'L'], 'sku' => 'WOO-TSHIRT-L', 'regular_price' => '79.00', 'manage_stock' => false],
        // Disabled in the admin ("Enabled" unticked).
        'xl' => ['attributes' => ['rozmiar' => 'XL'], 'sku' => 'WOO-TSHIRT-XL', 'regular_price' => '89.00', 'status' => 'private', 'manage_stock' => true, 'stock_quantity' => 0],
    ]
);
// Two attributes, a parent without a SKU and without stock management.
$hoodie = hanza_variable(
    ['name' => 'Bluza testowa'],
    ['Kolor' => ['Czarny', 'Szary'], 'Rozmiar' => ['M', 'L']],
    [
        'black_m' => ['attributes' => ['kolor' => 'Czarny', 'rozmiar' => 'M'], 'sku' => 'WOO-HOODIE-BLK-M', 'regular_price' => '159.00', 'manage_stock' => true, 'stock_quantity' => 9],
        'grey_l' => ['attributes' => ['kolor' => 'Szary', 'rozmiar' => 'L'], 'regular_price' => '159.00', 'manage_stock' => true, 'stock_quantity' => 6],
    ]
);

$products['grouped'] = hanza_product(new WC_Product_Grouped(), [
    'name' => 'Zestaw biurowy', 'sku' => 'WOO-SET-1', 'children' => [$products['mug'], $products['notebook']],
]);
$products['external'] = hanza_product(new WC_Product_External(), [
    'name' => 'Produkt partnera', 'sku' => 'WOO-EXT-1', 'regular_price' => '25.00',
    'product_url' => 'https://partner.example.test/produkt', 'button_text' => 'Kup u partnera',
]);

$coupon = new WC_Coupon();
$coupon->set_props(['code' => 'test10', 'discount_type' => 'fixed_cart', 'amount' => '10']);
$coupon->save();

// --- Buyers ---------------------------------------------------------------------------------------------------

function hanza_address(string $first, string $last, string $street, string $postcode, string $city, array $more = []): array
{
    return $more + [
        'first_name' => $first, 'last_name' => $last, 'company' => '', 'address_1' => $street, 'address_2' => '',
        'city' => $city, 'state' => '', 'postcode' => $postcode, 'country' => 'PL',
    ];
}

$jan = hanza_address('Jan', 'Testowy', 'ul. Przykładowa 1/2', '00-001', 'Warszawa', ['email' => 'jan.testowy@example.test', 'phone' => '+48 000 000 101']);
$anna = hanza_address('Anna', 'Przykładowa', 'ul. Zmyślona 15', '30-001', 'Kraków', ['email' => 'anna.przykladowa@example.test', 'phone' => '000 000 102']);
$piotr = hanza_address('Piotr', 'Zmyślony', 'al. Fikcyjna 7 m. 3', '80-001', 'Gdańsk', ['email' => 'piotr.zmyslony@example.test', 'phone' => '+48 000 000 103', 'address_2' => 'klatka B']);
$ewa = hanza_address('Ewa', 'Fikcyjna', 'ul. Wymyślona 22', '50-001', 'Wrocław', ['email' => 'ewa.fikcyjna@example.test', 'phone' => '+48 000 000 104', 'company' => 'Fikcyjna Firma Sp. z o.o.']);
$hans = hanza_address('Hans', 'Beispiel', 'Musterstraße 1', '10115', 'Berlin', ['email' => 'hans.beispiel@example.test', 'phone' => '+49 000 0000 105', 'country' => 'DE', 'state' => 'DE-BE']);
// Where Ewa's company has its parcels sent: another person, another city, no e-mail.
$marek = hanza_address('Marek', 'Odbiorca', 'ul. Magazynowa 5', '90-001', 'Łódź', ['phone' => '+48 000 000 106', 'company' => 'Fikcyjna Firma Sp. z o.o. Magazyn']);

// --- Orders ---------------------------------------------------------------------------------------------------

// 08:00 in Warsaw (06:00 UTC); each order is placed some minutes after it.
$t0 = (new DateTimeImmutable('2026-09-21 08:00:00', new DateTimeZone('Europe/Warsaw')))->getTimestamp();

/**
 * $spec: lines [[product id, quantity], ...], billing, shipping (optional), minute (after $t0), method
 * ('przelewy24' | 'cod' | 'bacs' | 'stripe'), flow (statuses to walk through; 'paid' is a completed online payment),
 * and optionally courier (bool), coupon, note, status (set as is, for statuses nothing transitions to).
 */
function hanza_order(array $spec, int $t0): int
{
    static $titles = ['przelewy24' => 'Przelewy24', 'cod' => 'Płatność przy odbiorze', 'bacs' => 'Przelew bankowy', 'stripe' => 'Karta płatnicza'];
    static $sequence = 0;
    $sequence++;

    $created = $t0 + 60 * $spec['minute'];
    $order = wc_create_order(['created_via' => 'sandbox']);
    foreach ($spec['lines'] as [$product_id, $quantity]) {
        $order->add_product(wc_get_product($product_id), $quantity);
    }
    if (isset($spec['billing'])) {
        $order->set_address($spec['billing'], 'billing');
    }
    if (isset($spec['shipping'])) {
        $order->set_address($spec['shipping'], 'shipping');
    }
    if ($spec['courier'] ?? false) {
        $courier = new WC_Order_Item_Shipping();
        $courier->set_props(['method_title' => 'Kurier testowy', 'method_id' => 'flat_rate', 'total' => '12.19']);
        $order->add_item($courier);
    }
    $order->set_payment_method($spec['method']);
    $order->set_payment_method_title($titles[$spec['method']]);
    $order->set_customer_ip_address('192.0.2.' . (10 + $sequence));
    $order->set_customer_user_agent('HanzaSandboxBrowser/1.0');
    if (isset($spec['note'])) {
        $order->set_customer_note($spec['note']);
    }
    $order->set_date_created($created);
    $order->calculate_totals();
    if (isset($spec['coupon'])) {
        $order->apply_coupon($spec['coupon']);
    }
    $order->save();

    foreach ($spec['flow'] ?? [] as $step) {
        if ($step === 'paid') {
            $order->set_date_paid($created + 120);
            $order->payment_complete(sprintf('SANDBOX-TXN-%04d', $sequence));
        } else {
            $order->update_status($step);
        }
    }
    if (isset($spec['status'])) {
        $order->set_status($spec['status']);
        $order->save();
    }
    return $order->get_id();
}

$p = $products;
$orders = [
    'paid_online' => ['lines' => [[$p['mug'], 1]], 'billing' => $jan, 'shipping' => $jan, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid'], 'minute' => 0],
    'cod' => ['lines' => [[$p['notebook'], 2]], 'billing' => $anna, 'shipping' => $anna, 'courier' => true, 'method' => 'cod', 'flow' => ['processing'], 'minute' => 10],
    'bacs' => ['lines' => [[$p['mug'], 1], [$p['notebook'], 1]], 'billing' => $piotr, 'shipping' => $piotr, 'courier' => true, 'method' => 'bacs', 'flow' => ['on-hold'], 'minute' => 20],
    'pending' => ['lines' => [[$p['backpack'], 1]], 'billing' => $ewa, 'shipping' => $ewa, 'courier' => true, 'method' => 'przelewy24', 'minute' => 30],
    'completed' => ['lines' => [[$p['notebook'], 3]], 'billing' => $jan, 'shipping' => $jan, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid', 'completed'], 'minute' => 40],
    'cancelled' => ['lines' => [[$p['mug'], 2]], 'billing' => $anna, 'shipping' => $anna, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['cancelled'], 'minute' => 50],
    'refunded' => ['lines' => [[$p['candle'], 1]], 'billing' => $piotr, 'shipping' => $piotr, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid', 'refunded'], 'minute' => 60],
    'failed' => ['lines' => [[$p['mug'], 1]], 'billing' => $ewa, 'shipping' => $ewa, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['failed'], 'minute' => 70],
    // Several lines, two of them variations (one with the parent's SKU), a product without a SKU, a coupon,
    // a company, and a parcel sent to somebody else.
    'multi_line' => ['lines' => [[$tshirt['s'], 2], [$tshirt['m'], 1], [$p['mug'], 3], [$p['poster'], 1]], 'billing' => $ewa, 'shipping' => $marek, 'courier' => true, 'coupon' => 'test10', 'method' => 'przelewy24', 'flow' => ['paid'], 'minute' => 80],
    // Virtual goods: no shipping address at all.
    'virtual' => ['lines' => [[$p['gift_card'], 1]], 'billing' => $anna, 'method' => 'przelewy24', 'flow' => ['paid'], 'minute' => 90],
    // Outside Poland: no tax rate applies, and the address has a state.
    'foreign' => ['lines' => [[$hoodie['black_m'], 1]], 'billing' => $hans, 'shipping' => $hans, 'courier' => true, 'method' => 'stripe', 'flow' => ['paid'], 'minute' => 100],
    'customer_note' => ['lines' => [[$p['candle'], 2]], 'billing' => $piotr, 'shipping' => $piotr, 'courier' => true, 'method' => 'bacs', 'flow' => ['on-hold'], 'note' => 'Proszę zostawić paczkę u sąsiada spod numeru 4.', 'minute' => 110],
    // Its first line's product is deleted below.
    'deleted_product' => ['lines' => [[$p['gone'], 1], [$p['mug'], 1]], 'billing' => $jan, 'shipping' => $jan, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid'], 'minute' => 120],
    // Two orders that do not fit the canonical Order: no lines, and no address at all.
    'no_lines' => ['lines' => [], 'billing' => $anna, 'shipping' => $anna, 'method' => 'bacs', 'flow' => ['on-hold'], 'minute' => 130],
    'no_address' => ['lines' => [[$p['mug'], 1]], 'method' => 'cod', 'flow' => ['processing'], 'minute' => 140],
    // A checkout a Buyer opened and has not placed.
    'checkout_draft' => ['lines' => [[$p['mug'], 1]], 'billing' => $ewa, 'method' => 'przelewy24', 'status' => 'checkout-draft', 'minute' => 150],
    // Paid, then moved to a status only a plugin knows.
    'plugin_status' => ['lines' => [[$p['notebook'], 1]], 'billing' => $piotr, 'shipping' => $piotr, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid'], 'status' => 'packing', 'minute' => 160],
    'cod_completed' => ['lines' => [[$p['mug'], 1]], 'billing' => $anna, 'shipping' => $anna, 'courier' => true, 'method' => 'cod', 'flow' => ['processing', 'completed'], 'minute' => 170],
    // Paid, then put on hold by the seller.
    'on_hold_after_payment' => ['lines' => [[$p['notebook'], 1]], 'billing' => $jan, 'shipping' => $jan, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid', 'on-hold'], 'minute' => 180],
    // More open orders, so a listing with a small page size spans several pages. open_3 and open_4 are placed in
    // the same second, and open_8 has the highest id but the earliest time: id order and time order differ.
    'open_1' => ['lines' => [[$p['notebook'], 1]], 'billing' => $anna, 'shipping' => $anna, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid'], 'minute' => 190],
    'open_2' => ['lines' => [[$p['mug'], 2]], 'billing' => $piotr, 'shipping' => $piotr, 'courier' => true, 'method' => 'bacs', 'flow' => ['on-hold'], 'minute' => 200],
    'open_3' => ['lines' => [[$tshirt['l'], 1]], 'billing' => $ewa, 'shipping' => $ewa, 'courier' => true, 'method' => 'przelewy24', 'minute' => 210],
    'open_4' => ['lines' => [[$p['candle'], 1]], 'billing' => $jan, 'shipping' => $jan, 'courier' => true, 'method' => 'cod', 'flow' => ['processing'], 'minute' => 210],
    'open_5' => ['lines' => [[$hoodie['grey_l'], 2]], 'billing' => $anna, 'shipping' => $anna, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid'], 'minute' => 220],
    'open_6' => ['lines' => [[$p['notebook'], 5]], 'billing' => $piotr, 'shipping' => $piotr, 'courier' => true, 'method' => 'bacs', 'flow' => ['on-hold'], 'minute' => 230],
    'open_7' => ['lines' => [[$p['backpack'], 1]], 'billing' => $ewa, 'shipping' => $ewa, 'courier' => true, 'method' => 'przelewy24', 'minute' => 240],
    'open_8' => ['lines' => [[$p['mug'], 1]], 'billing' => $jan, 'shipping' => $jan, 'courier' => true, 'method' => 'przelewy24', 'flow' => ['paid'], 'minute' => -1440],
];

$order_ids = [];
foreach ($orders as $name => $spec) {
    $order_ids[$name] = hanza_order($spec, $t0);
}

wc_get_product($products['gone'])->delete(true);

update_option('hanza_sandbox_seeded', '1');

foreach (['products' => $products, 'tshirt' => $tshirt, 'hoodie' => $hoodie, 'orders' => $order_ids] as $label => $ids) {
    WP_CLI::log($label . ': ' . wp_json_encode($ids));
}
WP_CLI::success(sprintf('Seeded %d products and %d orders.', count($products) + 2, count($order_ids)));

import 'package:flutter/material.dart';

import '../data/models/user.dart';

/// The app's navigation menu — the mobile mirror of `web/lib/menuTree.js`.
/// Groups, labels, order and `module` permission slugs match the web sidebar so
/// a user sees the same things in both products. `route: null` = the screen is
/// not built yet; the UI renders it disabled with a "Soon" tag (the same idea as
/// the web's `soon: true`).
class MenuEntry {
  const MenuEntry({
    required this.key,
    required this.label,
    required this.icon,
    required this.module,
    this.route,
    this.adminOnly = false,
    this.salesmanOnly = false,
    this.approverOnly = false,
    this.create = false,
  });

  final String key;
  final String label;
  final IconData icon;

  /// Permission slug, e.g. 'sales-invoices' — identical to the web's `module`.
  final String module;

  /// Where tapping goes; null → the screen is not built yet.
  final String? route;

  /// Company/super admin only (the web's `adminOnly`).
  final bool adminOnly;

  /// Only a LINKED field salesman sees it (the web's `salesmanOnly`).
  final bool salesmanOnly;

  /// Approvers only: needs `<module>.edit` and must NOT be a salesman or a
  /// customer-portal login (they cannot self-approve; the API 403s them too).
  final bool approverOnly;

  /// Belongs to the Create (+) sheet rather than the browsing menus.
  final bool create;
}

class MenuGroup {
  const MenuGroup({required this.label, required this.icon, required this.items});
  final String label;
  final IconData icon;
  final List<MenuEntry> items;
}

const List<MenuGroup> kAppMenu = [
  MenuGroup(label: 'Create Vouchers', icon: Icons.add_circle_outline, items: [
    MenuEntry(key: 'new-quotation', label: 'Quotation', icon: Icons.description_outlined, module: 'quotations', route: '/quotations/add', create: true),
    MenuEntry(key: 'new-sales-inv', label: 'Sales Invoice', icon: Icons.receipt_long_outlined, module: 'sales-invoices', route: '/sales-invoices/add', create: true),
    MenuEntry(key: 'new-receipt', label: 'Receipt', icon: Icons.receipt_outlined, module: 'receipts', route: '/receipts/add', create: true),
    MenuEntry(key: 'new-payment', label: 'Payment', icon: Icons.payments_outlined, module: 'payments', route: '/payments/add', create: true),
    MenuEntry(key: 'new-sales-order', label: 'Sales Order', icon: Icons.shopping_cart_outlined, module: 'sales-orders', route: '/sales-orders/add', create: true),
    MenuEntry(key: 'new-purchase', label: 'Purchase Invoice', icon: Icons.download_outlined, module: 'purchase-invoices', route: '/purchase-invoices/add', create: true),
    MenuEntry(key: 'new-journal', label: 'Journal', icon: Icons.menu_book_outlined, module: 'journals', route: '/journals/add', create: true),
    MenuEntry(key: 'new-contra', label: 'Contra', icon: Icons.swap_horiz, module: 'contra', route: '/contra/add', create: true),
    MenuEntry(key: 'new-po', label: 'Purchase Order', icon: Icons.local_shipping_outlined, module: 'purchase-orders', route: '/purchase-orders/add', create: true),
    MenuEntry(key: 'new-credit-note', label: 'Credit Note', icon: Icons.remove_circle_outline, module: 'credit-notes', route: '/credit-notes/add', create: true),
    MenuEntry(key: 'new-debit-note', label: 'Debit Note', icon: Icons.add_circle_outline, module: 'debit-notes', route: '/debit-notes/add', create: true),
    MenuEntry(key: 'new-stock-jrnl', label: 'Stock Journal', icon: Icons.inventory_outlined, module: 'stock-journal', route: '/stock-journals/add', create: true),
    MenuEntry(key: 'new-phys-stock', label: 'Physical Stock', icon: Icons.checklist_outlined, module: 'physical-stock', route: '/physical-stock/add', create: true),
    MenuEntry(key: 'new-recpt-note', label: 'Receipt Note', icon: Icons.move_to_inbox_outlined, module: 'receipt-notes', route: '/receipt-notes/add', create: true),
    MenuEntry(key: 'new-dely-note', label: 'Delivery Note', icon: Icons.local_shipping_outlined, module: 'delivery-notes', route: '/delivery-notes/add', create: true),
  ]),
  MenuGroup(label: 'Sales', icon: Icons.trending_up, items: [
    MenuEntry(key: 'quotations', label: 'Quotations', icon: Icons.description_outlined, module: 'quotations', route: '/quotations'),
    MenuEntry(key: 'sales-inv', label: 'Sales', icon: Icons.receipt_long_outlined, module: 'sales-invoices', route: '/sales-invoices'),
    MenuEntry(key: 'credit-notes', label: 'Credit Note', icon: Icons.remove_circle_outline, module: 'credit-notes', route: '/credit-notes'),
    MenuEntry(key: 'receipts', label: 'Receipt', icon: Icons.receipt_outlined, module: 'receipts', route: '/receipts'),
    MenuEntry(key: 'receivables', label: 'Receivables', icon: Icons.volunteer_activism_outlined, module: 'receivables', route: '/receivables'),
    MenuEntry(key: 'sales-orders', label: 'Sales Order', icon: Icons.shopping_cart_outlined, module: 'sales-orders', route: '/sales-orders'),
    MenuEntry(key: 'dely-notes', label: 'Delivery Note', icon: Icons.local_shipping_outlined, module: 'delivery-notes', route: '/delivery-notes'),
    MenuEntry(key: 'approvals', label: 'Invoice Approvals', icon: Icons.fact_check_outlined, module: 'sales-invoices', route: '/sales-invoices/approvals', approverOnly: true),
    MenuEntry(key: 'recurring', label: 'Recurring Invoices', icon: Icons.repeat, module: 'recurring-invoices', route: '/recurring-invoices'),
    MenuEntry(key: 'einvoice', label: 'e-Invoice & e-Way', icon: Icons.verified_outlined, module: 'einvoice', route: '/einvoices'),
    MenuEntry(key: 'einvoice-dash', label: 'e-Invoice Dashboard', icon: Icons.speed_outlined, module: 'einvoice'),
    MenuEntry(key: 'reminders', label: 'Payment Reminders', icon: Icons.notifications_outlined, module: 'payments', route: '/reminders'),
  ]),
  MenuGroup(label: 'Purchase', icon: Icons.shopping_bag_outlined, items: [
    MenuEntry(key: 'purchase-inv', label: 'Purchase', icon: Icons.download_outlined, module: 'purchase-invoices', route: '/purchase-invoices'),
    MenuEntry(key: 'debit-notes', label: 'Debit Note', icon: Icons.add_circle_outline, module: 'debit-notes', route: '/debit-notes'),
    MenuEntry(key: 'payments', label: 'Payment', icon: Icons.payments_outlined, module: 'payments', route: '/payments'),
    MenuEntry(key: 'payables', label: 'Payables', icon: Icons.account_balance_wallet_outlined, module: 'payables', route: '/payables'),
    MenuEntry(key: 'purch-orders', label: 'Purchase Order', icon: Icons.local_shipping_outlined, module: 'purchase-orders', route: '/purchase-orders'),
    MenuEntry(key: 'recpt-notes', label: 'Receipt Note', icon: Icons.move_to_inbox_outlined, module: 'receipt-notes', route: '/receipt-notes'),
    MenuEntry(key: 'expenses', label: 'Expenses', icon: Icons.account_balance_wallet_outlined, module: 'expenses', route: '/expenses'),
  ]),
  MenuGroup(label: 'Cash & Bank', icon: Icons.savings_outlined, items: [
    MenuEntry(key: 'cash', label: 'Cash', icon: Icons.money, module: 'cash-bank', route: '/cash'),
    MenuEntry(key: 'bank-ledgers', label: 'Bank', icon: Icons.account_balance_outlined, module: 'cash-bank', route: '/bank'),
    MenuEntry(key: 'bank', label: 'Bank Reconciliation', icon: Icons.balance_outlined, module: 'bank-reconciliation', route: '/bank-reconciliation'),
    MenuEntry(key: 'journals', label: 'Journals', icon: Icons.menu_book_outlined, module: 'journals', route: '/journals'),
    MenuEntry(key: 'contra', label: 'Contra', icon: Icons.swap_horiz, module: 'contra', route: '/contra'),
    MenuEntry(key: 'collect-payments', label: 'Collect Payments', icon: Icons.credit_card, module: 'collect-payments', route: '/collect-payments'),
  ]),
  MenuGroup(label: 'Customers', icon: Icons.contacts_outlined, items: [
    MenuEntry(key: 'customers', label: 'Customers', icon: Icons.people_outline, module: 'customers', route: '/customers'),
    MenuEntry(key: 'suppliers', label: 'Suppliers', icon: Icons.local_shipping_outlined, module: 'suppliers', route: '/suppliers'),
  ]),
  MenuGroup(label: 'Items', icon: Icons.inventory_2_outlined, items: [
    MenuEntry(key: 'products', label: 'Products', icon: Icons.inventory_2_outlined, module: 'products', route: '/products'),
    MenuEntry(key: 'categories', label: 'Categories', icon: Icons.category_outlined, module: 'categories', route: '/categories'),
    MenuEntry(key: 'inventory', label: 'Inventory', icon: Icons.warehouse_outlined, module: 'inventory', route: '/inventory'),
    MenuEntry(key: 'stock-journals', label: 'Stock Journal', icon: Icons.inventory_outlined, module: 'stock-journal', route: '/stock-journals'),
    MenuEntry(key: 'physical-stock', label: 'Physical Stock', icon: Icons.checklist_outlined, module: 'physical-stock', route: '/physical-stock'),
  ]),
  MenuGroup(label: 'Reports', icon: Icons.bar_chart_outlined, items: [
    MenuEntry(key: 'reports', label: 'Reports', icon: Icons.bar_chart_outlined, module: 'reports', route: '/reports'),
    MenuEntry(key: 'analytics', label: 'Business Analytics', icon: Icons.pie_chart_outline, module: 'reports', route: '/analytics'),
  ]),
  MenuGroup(label: 'My Entries', icon: Icons.check_box_outlined, items: [
    MenuEntry(key: 'my-vouchers', label: 'My Vouchers', icon: Icons.description_outlined, module: 'field-sales', route: '/my-vouchers'),
    MenuEntry(key: 'my-quotations', label: 'My Quotations', icon: Icons.edit_document, module: 'quotations', route: '/my-quotations'),
    MenuEntry(key: 'my-eway', label: 'My eWay Bills', icon: Icons.local_shipping_outlined, module: 'field-sales', route: '/my-eway'),
    MenuEntry(key: 'my-einvoices', label: 'My eInvoices', icon: Icons.verified_outlined, module: 'field-sales', route: '/my-einvoices'),
    MenuEntry(key: 'my-parties', label: 'My Parties', icon: Icons.contacts_outlined, module: 'field-sales', route: '/my-customers'),
    MenuEntry(key: 'my-stock', label: 'My Stock Items', icon: Icons.inventory_2_outlined, module: 'field-sales', route: '/products'),
    MenuEntry(key: 'field-tracking', label: 'Tracking Report', icon: Icons.map_outlined, module: 'field-sales', route: '/field-tracking', approverOnly: true),
  ]),
  MenuGroup(label: 'Field Sales', icon: Icons.place_outlined, items: [
    MenuEntry(key: 'my-field', label: 'My Dashboard', icon: Icons.place_outlined, module: 'field-sales', route: '/my-field', salesmanOnly: true),
    MenuEntry(key: 'sales', label: 'Sales Persons', icon: Icons.badge_outlined, module: 'sales-persons', route: '/sales-persons'),
    MenuEntry(key: 'gps-settings', label: 'GPS Tracking', icon: Icons.my_location, module: 'gps-tracking', adminOnly: true),
  ]),
  MenuGroup(label: 'Portals', icon: Icons.public, items: [
    MenuEntry(key: 'customer-users', label: 'Customer Users', icon: Icons.lock_person_outlined, module: 'customer-users'),
    MenuEntry(key: 'website-users', label: 'Website Users', icon: Icons.public, module: 'website-users'),
  ]),
  MenuGroup(label: 'Tally Sync', icon: Icons.sync, items: [
    MenuEntry(key: 'sync-dash', label: 'Sync Dashboard', icon: Icons.sync, module: 'tally-sync', route: '/sync', adminOnly: true),
    MenuEntry(key: 'sync-logs', label: 'Sync Logs', icon: Icons.playlist_add_check, module: 'tally-sync', route: '/sync-logs', adminOnly: true),
    MenuEntry(key: 'history', label: 'Change History', icon: Icons.history, module: 'tally-sync', route: '/change-history', adminOnly: true),
  ]),
  MenuGroup(label: 'Configurations', icon: Icons.tune, items: [
    MenuEntry(key: 'settings', label: 'Settings', icon: Icons.settings_outlined, module: 'settings', route: '/settings'),
    MenuEntry(key: 'users', label: 'Users', icon: Icons.group_outlined, module: 'users', route: '/users'),
    MenuEntry(key: 'roles', label: 'Roles & Permissions', icon: Icons.admin_panel_settings_outlined, module: 'users', route: '/roles', adminOnly: true),
    MenuEntry(key: 'accountant', label: 'Accountant Access', icon: Icons.badge_outlined, module: 'accountant', route: '/accountant-access'),
    MenuEntry(key: 'companies', label: 'Companies', icon: Icons.business_outlined, module: 'companies', route: '/companies'),
    MenuEntry(key: 'locations', label: 'Locations', icon: Icons.place_outlined, module: 'locations', route: '/locations'),
  ]),
  MenuGroup(label: 'General', icon: Icons.grid_view, items: [
    MenuEntry(key: 'gst-search', label: 'GST Search', icon: Icons.search, module: 'gst-search'),
    MenuEntry(key: 'data-backup', label: 'Data Backup', icon: Icons.cloud_upload_outlined, module: 'data-backup'),
  ]),
];

/// True when [user] may see [e] — mirrors the web sidebar's filter rules.
bool _visible(MenuEntry e, AppUser? user) {
  if (user == null) return true; // pre-login render; the router gates access
  if (e.salesmanOnly) return user.isSalesman;
  if (e.adminOnly) return user.isSuperAdmin || user.can(e.module, 'edit');
  if (e.approverOnly) {
    return user.can(e.module, 'edit') && !user.isSalesman && !user.isCustomerUser;
  }
  return user.canModule(e.module);
}

/// The menu [user] may see. Groups whose items all filter out are dropped, and
/// the Create Vouchers group is excluded — it belongs to the Create (+) sheet.
List<MenuGroup> visibleMenu(AppUser? user) {
  final out = <MenuGroup>[];
  for (final g in kAppMenu) {
    if (g.label == 'Create Vouchers') continue;
    final items = [for (final e in g.items) if (_visible(e, user)) e];
    if (items.isNotEmpty) {
      out.add(MenuGroup(label: g.label, icon: g.icon, items: items));
    }
  }
  return out;
}

/// The voucher types [user] may create — the Create (+) sheet's contents.
List<MenuEntry> visibleCreateEntries(AppUser? user) => [
      for (final e in kAppMenu.firstWhere((g) => g.label == 'Create Vouchers').items)
        if (user == null || user.can(e.module, 'create')) e,
    ];

/// The group with [label] from the FULL menu, or null. Used by the Sales /
/// Purchase tabs, which render one group each.
MenuGroup? menuGroup(String label) {
  for (final g in kAppMenu) {
    if (g.label == label) return g;
  }
  return null;
}

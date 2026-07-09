import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/api/endpoints.dart';
import '../core/auth/session.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/forgot_password_screen.dart';
import '../features/categories/categories_screen.dart';
import '../features/categories/category_detail_screen.dart';
import '../features/categories/category_form_screen.dart';
import '../features/companies/companies_screen.dart';
import '../features/companies/company_detail_screen.dart';
import '../features/companies/company_form_screen.dart';
import '../features/company_switcher/company_switcher_screen.dart';
import '../features/customers/customer_detail_screen.dart';
import '../features/customers/customer_form_screen.dart';
import '../features/customers/customers_screen.dart';
import '../features/dashboard/dashboard_screen.dart';
import '../features/field/approvals_screen.dart';
import '../features/field/checkin_screen.dart';
import '../features/field/field_dashboard_screen.dart';
import '../features/field/my_approvals_screen.dart';
import '../features/field/my_customers_screen.dart';
import '../features/field/my_locations_screen.dart';
import '../features/field/part_visit_screen.dart';
import '../features/field/visits_screen.dart';
import '../features/journals/journal_detail_screen.dart';
import '../features/journals/journal_form_screen.dart';
import '../features/journals/journals_screen.dart';
import '../features/inventory/inventory_screen.dart';
import '../features/locations/location_detail_screen.dart';
import '../features/locations/location_form_screen.dart';
import '../features/locations/locations_screen.dart';
import '../features/masters/masters_hub_screen.dart';
import '../features/payments/voucher_detail_screen.dart';
import '../features/payments/voucher_form_screen.dart';
import '../features/payments/vouchers_screen.dart';
import '../features/products/product_detail_screen.dart';
import '../features/products/product_form_screen.dart';
import '../features/products/products_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/purchase_invoices/purchase_invoice_form_screen.dart';
import '../features/reports/report_view_screen.dart';
import '../features/reports/reports_screen.dart';
import '../features/sales_invoices/invoice_register_screen.dart';
import '../features/sales_invoices/sales_invoice_form_screen.dart';
import '../features/sales_persons/sales_person_detail_screen.dart';
import '../features/sales_persons/sales_person_form_screen.dart';
import '../features/sales_persons/sales_persons_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/suppliers/supplier_detail_screen.dart';
import '../features/suppliers/supplier_form_screen.dart';
import '../features/suppliers/suppliers_screen.dart';
import '../features/notifications/notifications_screen.dart';
import '../features/users/accountant_access_screen.dart';
import '../features/reminders/reminders_screen.dart';
import '../features/analytics/analytics_screen.dart';
import '../features/expenses/expenses_screen.dart';
import '../features/recurring_invoices/recurring_invoices_screen.dart';
import '../features/bank_reconciliation/bank_reconciliation_screen.dart';
import '../features/einvoices/einvoices_screen.dart';
import '../features/users/roles_screen.dart';
import '../features/users/users_screen.dart';
import '../features/sync/change_history_screen.dart';
import '../features/sync/sync_logs_screen.dart';
import '../features/sync/sync_dashboard_screen.dart';
import '../features/transactions/invoice_detail_screen.dart';
import '../features/transactions/transactions_hub_screen.dart';
import '../features/splash/splash_screen.dart';
import '../shared/layouts/app_shell.dart';

/// Route map:
///
///   /            → SplashScreen     (hydrate session, then redirect)
///   /login       → LoginScreen
///   /dashboard   ┐
///   /customers   ├─ inside AppShell (bottom-nav tabs)
///   /reports     │
///   /profile     ┘
///
/// AppShell uses `StatefulShellRoute.indexedStack` so each tab keeps its
/// own navigation history + scroll position when the user switches.
///
/// `refreshListenable` is wired to `sessionProvider` so a login / logout
/// re-runs the redirect logic without any imperative `context.go` calls —
/// the session state flips and GoRouter bounces the user to the right place.
final routerProvider = Provider<GoRouter>((ref) {
  final notifier = _SessionListener(ref);
  return GoRouter(
    initialLocation: '/',
    debugLogDiagnostics: false,
    refreshListenable: notifier,
    redirect: (context, state) {
      final session = ref.read(sessionProvider);
      final going = state.uri.path;

      // While the splash is still hydrating, keep the user on '/' so we
      // don't flash login → dashboard if cached creds are about to load.
      if (session is SessionLoading) return going == '/' ? null : '/';

      final isLogin = going == '/login';
      final isSplash = going == '/';

      if (session is SessionAnonymous) {
        // Signed-out users may stay on login OR the public forgot-password
        // flow; anything else bounces to login.
        final isPublic = isLogin || going == '/forgot-password';
        return isPublic ? null : '/login';
      }
      if (session is SessionSignedIn) {
        // Signed-in users have no business on splash / login — send them in.
        if (isSplash || isLogin) return '/dashboard';
        return null;
      }
      return null;
    },
    routes: [
      // ─── Public ─────────────────────────────────────────────
      GoRoute(
        path: '/',
        name: 'splash',
        builder: (_, __) => const SplashScreen(),
      ),
      GoRoute(
        path: '/login',
        name: 'login',
        builder: (_, __) => const LoginScreen(),
      ),
      GoRoute(
        path: '/forgot-password',
        name: 'forgot-password',
        builder: (_, __) => const ForgotPasswordScreen(),
      ),

      // ─── Authed shell ───────────────────────────────────────
      // Four branches → bottom-nav tabs. Each branch can grow nested
      // routes later (e.g. /customers/:id) without touching the tabs.
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => AppShell(navigationShell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/dashboard',
              name: 'dashboard',
              builder: (_, __) => const DashboardScreen(),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/masters',
              name: 'masters',
              builder: (_, __) => const MastersHubScreen(),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/transactions',
              name: 'transactions',
              builder: (_, __) => const TransactionsHubScreen(),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/reports',
              name: 'reports',
              builder: (_, __) => const ReportsScreen(),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/profile',
              name: 'profile',
              builder: (_, __) => const ProfileScreen(),
            ),
          ]),
        ],
      ),

      // ─── Side trips (pushed full-screen over the active tab) ────
      // Master list + form screens are reached from the Masters hub (the 2nd
      // tab), not as tabs themselves — there are more masters than fit a
      // bottom-nav, so they live as pushed routes.
      GoRoute(
        path: '/companies',
        name: 'companies',
        builder: (_, __) => const CompaniesScreen(),
      ),
      GoRoute(
        path: '/companies/add',
        name: 'company-add',
        builder: (_, __) => const CompanyFormScreen(),
      ),
      GoRoute(
        path: '/companies/:id',
        name: 'company-view',
        builder: (_, state) =>
            CompanyDetailScreen(companyId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/companies/:id/edit',
        name: 'company-edit',
        builder: (_, state) =>
            CompanyFormScreen(companyId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/customers',
        name: 'customers',
        builder: (_, __) => const CustomersScreen(),
      ),
      GoRoute(
        path: '/customers/add',
        name: 'customer-add',
        builder: (_, __) => const CustomerFormScreen(),
      ),
      // Declared AFTER '/customers/add' so the literal 'add' wins over ':id'.
      GoRoute(
        path: '/customers/:id',
        name: 'customer-view',
        builder: (_, state) =>
            CustomerDetailScreen(customerId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/customers/:id/edit',
        name: 'customer-edit',
        builder: (_, state) =>
            CustomerFormScreen(customerId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/suppliers',
        name: 'suppliers',
        builder: (_, __) => const SuppliersScreen(),
      ),
      GoRoute(
        path: '/suppliers/add',
        name: 'supplier-add',
        builder: (_, __) => const SupplierFormScreen(),
      ),
      GoRoute(
        path: '/suppliers/:id',
        name: 'supplier-view',
        builder: (_, state) =>
            SupplierDetailScreen(supplierId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/suppliers/:id/edit',
        name: 'supplier-edit',
        builder: (_, state) =>
            SupplierFormScreen(supplierId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/products',
        name: 'products',
        builder: (_, __) => const ProductsScreen(),
      ),
      GoRoute(
        path: '/products/add',
        name: 'product-add',
        builder: (_, __) => const ProductFormScreen(),
      ),
      GoRoute(
        path: '/products/:id',
        name: 'product-view',
        builder: (_, state) =>
            ProductDetailScreen(productId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/products/:id/edit',
        name: 'product-edit',
        builder: (_, state) =>
            ProductFormScreen(productId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/categories',
        name: 'categories',
        builder: (_, __) => const CategoriesScreen(),
      ),
      GoRoute(
        path: '/categories/add',
        name: 'category-add',
        builder: (_, __) => const CategoryFormScreen(),
      ),
      GoRoute(
        path: '/categories/:id',
        name: 'category-view',
        builder: (_, state) =>
            CategoryDetailScreen(categoryId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/categories/:id/edit',
        name: 'category-edit',
        builder: (_, state) =>
            CategoryFormScreen(categoryId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/locations',
        name: 'locations',
        builder: (_, __) => const LocationsScreen(),
      ),
      GoRoute(
        path: '/locations/add',
        name: 'location-add',
        builder: (_, __) => const LocationFormScreen(),
      ),
      GoRoute(
        path: '/locations/:id',
        name: 'location-view',
        builder: (_, state) =>
            LocationDetailScreen(locationId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/locations/:id/edit',
        name: 'location-edit',
        builder: (_, state) =>
            LocationFormScreen(locationId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/sales-persons',
        name: 'sales-persons',
        builder: (_, __) => const SalesPersonsScreen(),
      ),
      GoRoute(
        path: '/sales-persons/add',
        name: 'sales-person-add',
        builder: (_, __) => const SalesPersonFormScreen(),
      ),
      GoRoute(
        path: '/sales-persons/:id',
        name: 'sales-person-view',
        builder: (_, state) =>
            SalesPersonDetailScreen(salesPersonId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/sales-persons/:id/edit',
        name: 'sales-person-edit',
        builder: (_, state) =>
            SalesPersonFormScreen(salesPersonId: int.parse(state.pathParameters['id']!)),
      ),

      // ─── Transactions (side trips off the Transactions hub) ─────
      GoRoute(
        path: '/sales-invoices',
        name: 'sales-invoices',
        builder: (_, __) => const InvoiceRegisterScreen(
          title: 'Sales Register',
          monthlyPath: '/sales-invoices/monthly',
          basePath: '/sales-invoices',
          module: 'sales-invoices',
        ),
      ),
      GoRoute(
        path: '/sales-invoices/month/:ym',
        name: 'sales-invoices-month',
        builder: (_, state) => MonthInvoicesScreen(
          basePath: '/sales-invoices',
          month: state.pathParameters['ym']!,
        ),
      ),
      GoRoute(
        path: '/sales-invoices/add',
        name: 'sales-invoice-add',
        builder: (_, __) => const SalesInvoiceFormScreen(),
      ),
      // SFA — the logged-in salesman's field dashboard (assigned locations).
      GoRoute(
        path: '/my-field',
        name: 'my-field',
        builder: (_, __) => const FieldDashboardScreen(),
      ),
      // SFA — salesman's own assigned customers / locations (read-only) + their
      // invoices grouped by approval status (with edit & re-submit).
      GoRoute(
        path: '/my-customers',
        name: 'my-customers',
        builder: (_, __) => const MyCustomersScreen(),
      ),
      GoRoute(
        path: '/my-locations',
        name: 'my-locations',
        builder: (_, __) => const MyLocationsScreen(),
      ),
      GoRoute(
        path: '/my-approvals',
        name: 'my-approvals',
        builder: (_, state) =>
            MyApprovalsScreen(initialStatus: state.uri.queryParameters['status'] ?? 'pending'),
      ),
      GoRoute(
        path: '/field/checkin',
        name: 'field-checkin',
        builder: (_, __) => const CheckinScreen(),
      ),
      GoRoute(
        path: '/field/part-visit',
        name: 'field-part-visit',
        builder: (_, __) => const PartVisitScreen(),
      ),
      GoRoute(
        path: '/field/visits',
        name: 'field-visits',
        builder: (_, __) => const VisitsScreen(),
      ),
      // SFA — Invoice Approvals (admin). MUST precede '/sales-invoices/:id' so
      // "approvals" isn't captured as an invoice id.
      GoRoute(
        path: '/sales-invoices/approvals',
        name: 'sales-invoice-approvals',
        builder: (_, __) => const ApprovalsScreen(),
      ),
      // SFA — edit an un-approved invoice (draft/pending/rejected); saving
      // re-submits it. MUST precede '/sales-invoices/:id'.
      GoRoute(
        path: '/sales-invoices/:id/edit',
        name: 'sales-invoice-edit',
        builder: (_, state) =>
            SalesInvoiceFormScreen(editId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/sales-invoices/:id',
        name: 'sales-invoice-view',
        builder: (_, state) => InvoiceDetailScreen(
          basePath: Endpoints.salesInvoices,
          module: 'sales-invoices',
          title: 'Sales Invoice',
          invoiceId: int.parse(state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        path: '/purchase-invoices',
        name: 'purchase-invoices',
        builder: (_, __) => const InvoiceRegisterScreen(
          title: 'Purchase Register',
          monthlyPath: '/purchase-invoices/monthly',
          basePath: '/purchase-invoices',
          module: 'purchase-invoices',
        ),
      ),
      GoRoute(
        path: '/purchase-invoices/month/:ym',
        name: 'purchase-invoices-month',
        builder: (_, state) => MonthInvoicesScreen(
          basePath: '/purchase-invoices',
          month: state.pathParameters['ym']!,
        ),
      ),
      GoRoute(
        path: '/purchase-invoices/add',
        name: 'purchase-invoice-add',
        builder: (_, __) => const PurchaseInvoiceFormScreen(),
      ),
      GoRoute(
        path: '/purchase-invoices/:id',
        name: 'purchase-invoice-view',
        builder: (_, state) => InvoiceDetailScreen(
          basePath: Endpoints.purchaseInvoices,
          module: 'purchase-invoices',
          title: 'Purchase Invoice',
          invoiceId: int.parse(state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        path: '/payments',
        name: 'payments',
        builder: (_, __) => const VouchersScreen(
          basePath: '/payments',
          title: 'Payments',
          addRoute: '/payments/add',
          emptyText: 'No payments yet.',
          emptyIcon: Icons.south_west,
        ),
      ),
      GoRoute(
        path: '/payments/add',
        name: 'payment-add',
        builder: (_, __) => const VoucherFormScreen(
          title: 'New Payment',
          basePath: '/payments',
          partyKey: 'supplier_id',
          partyLabel: 'Supplier *',
          partyEndpoint: '/suppliers',
          saveLabel: 'Save Payment',
        ),
      ),
      GoRoute(
        path: '/payments/:id',
        name: 'payment-view',
        builder: (_, state) => VoucherDetailScreen(
          basePath: '/payments',
          module: 'payments',
          title: 'Payment',
          voucherId: int.parse(state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        path: '/receipts',
        name: 'receipts',
        builder: (_, __) => const VouchersScreen(
          basePath: '/receipts',
          title: 'Receipts',
          addRoute: '/receipts/add',
          emptyText: 'No receipts yet.',
          emptyIcon: Icons.north_east,
        ),
      ),
      GoRoute(
        path: '/receipts/add',
        name: 'receipt-add',
        builder: (_, __) => const VoucherFormScreen(
          title: 'New Receipt',
          basePath: '/receipts',
          partyKey: 'customer_id',
          partyLabel: 'Customer *',
          partyEndpoint: '/customers',
          saveLabel: 'Save Receipt',
        ),
      ),
      GoRoute(
        path: '/receipts/:id',
        name: 'receipt-view',
        builder: (_, state) => VoucherDetailScreen(
          basePath: '/receipts',
          module: 'receipts',
          title: 'Receipt',
          voucherId: int.parse(state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        path: '/journals',
        name: 'journals',
        builder: (_, __) => const JournalsScreen(),
      ),
      GoRoute(
        path: '/journals/add',
        name: 'journal-add',
        builder: (_, __) => const JournalFormScreen(),
      ),
      GoRoute(
        path: '/journals/:id',
        name: 'journal-view',
        builder: (_, state) =>
            JournalDetailScreen(journalId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/inventory',
        name: 'inventory',
        builder: (_, __) => const InventoryScreen(),
      ),

      // ─── Account / admin (reached from the Profile tab) ─────────
      GoRoute(
        path: '/company-switcher',
        name: 'company-switcher',
        builder: (_, __) => const CompanySwitcherScreen(),
      ),
      GoRoute(
        path: '/sync',
        name: 'sync',
        builder: (_, __) => const SyncDashboardScreen(),
      ),
      GoRoute(
        path: '/sync-logs',
        name: 'sync-logs',
        builder: (_, __) => const SyncLogsScreen(),
      ),
      GoRoute(
        path: '/change-history',
        name: 'change-history',
        builder: (_, __) => const ChangeHistoryScreen(),
      ),
      GoRoute(
        path: '/notifications',
        name: 'notifications',
        builder: (_, __) => const NotificationsScreen(),
      ),
      GoRoute(
        path: '/settings',
        name: 'settings-page',
        builder: (_, __) => const SettingsScreen(),
      ),
      GoRoute(
        path: '/users',
        name: 'users',
        builder: (_, __) => const UsersScreen(),
      ),
      GoRoute(
        path: '/roles',
        name: 'roles',
        builder: (_, __) => const RolesScreen(),
      ),
      GoRoute(
        path: '/accountant-access',
        name: 'accountant-access',
        builder: (_, __) => const AccountantAccessScreen(),
      ),
      GoRoute(
        path: '/reminders',
        name: 'reminders',
        builder: (_, __) => const RemindersScreen(),
      ),
      GoRoute(
        path: '/analytics',
        name: 'analytics',
        builder: (_, __) => const AnalyticsScreen(),
      ),
      GoRoute(
        path: '/expenses',
        name: 'expenses',
        builder: (_, __) => const ExpensesScreen(),
      ),
      GoRoute(
        path: '/recurring-invoices',
        name: 'recurring-invoices',
        builder: (_, __) => const RecurringInvoicesScreen(),
      ),
      GoRoute(
        path: '/bank-reconciliation',
        name: 'bank-reconciliation',
        builder: (_, __) => const BankReconciliationScreen(),
      ),
      GoRoute(
        path: '/einvoices',
        name: 'einvoices',
        builder: (_, __) => const EInvoicesScreen(),
      ),

      // ─── Reports (side trips off the Reports tab/hub) ───────────
      GoRoute(
        path: '/reports/sales-register',
        name: 'report-sales-register',
        builder: (_, __) => const ReportViewScreen(
          title: 'Sales Register',
          endpoint: Endpoints.reportsSalesRegister,
          kind: ReportKind.salesRegister,
          dateRange: true,
        ),
      ),
      GoRoute(
        path: '/reports/day-book',
        name: 'report-day-book',
        builder: (_, __) => const ReportViewScreen(
          title: 'Day Book',
          endpoint: Endpoints.reportsDayBook,
          kind: ReportKind.dayBook,
          dateRange: true,
        ),
      ),
      GoRoute(
        path: '/reports/receivables',
        name: 'report-receivables',
        builder: (_, __) => const ReportViewScreen(
          title: 'Receivables',
          endpoint: Endpoints.reportsOutstanding,
          kind: ReportKind.outstanding,
          extraQuery: {'type': 'receivable'},
        ),
      ),
      GoRoute(
        path: '/reports/payables',
        name: 'report-payables',
        builder: (_, __) => const ReportViewScreen(
          title: 'Payables',
          endpoint: Endpoints.reportsOutstanding,
          kind: ReportKind.outstanding,
          extraQuery: {'type': 'payable'},
        ),
      ),
      GoRoute(
        path: '/reports/ledger',
        name: 'report-ledger',
        builder: (_, __) => const ReportViewScreen(
          title: 'Party Ledger',
          endpoint: Endpoints.reportsLedger,
          kind: ReportKind.ledger,
          needsParty: true,
        ),
      ),
      GoRoute(
        path: '/reports/gst-summary',
        name: 'report-gst-summary',
        builder: (_, __) => const ReportViewScreen(
          title: 'GST Summary',
          endpoint: Endpoints.reportsGstSummary,
          kind: ReportKind.gstSummary,
          dateRange: true,
        ),
      ),
      GoRoute(
        path: '/reports/trial-balance',
        name: 'report-trial-balance',
        builder: (_, __) => const ReportViewScreen(
          title: 'Trial Balance',
          endpoint: Endpoints.reportsTrialBalance,
          kind: ReportKind.trialBalance,
        ),
      ),
      GoRoute(
        path: '/reports/profit-loss',
        name: 'report-profit-loss',
        builder: (_, __) => const ReportViewScreen(
          title: 'Profit & Loss',
          endpoint: Endpoints.reportsProfitLoss,
          kind: ReportKind.profitLoss,
        ),
      ),
      GoRoute(
        path: '/reports/balance-sheet',
        name: 'report-balance-sheet',
        builder: (_, __) => const ReportViewScreen(
          title: 'Balance Sheet',
          endpoint: Endpoints.reportsBalanceSheet,
          kind: ReportKind.balanceSheet,
        ),
      ),
      GoRoute(
        path: '/reports/stock-summary',
        name: 'report-stock-summary',
        builder: (_, __) => const ReportViewScreen(
          title: 'Stock Summary',
          endpoint: Endpoints.reportsStockSummary,
          kind: ReportKind.stockSummary,
        ),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      body: Center(child: Text('Route not found: ${state.uri}')),
    ),
  );
});

/// Bridges `sessionProvider` (a StateNotifier) to GoRouter's `Listenable`
/// contract. Each time the session state flips, GoRouter re-evaluates its
/// redirects — that's how login + logout drive navigation declaratively,
/// without any imperative `context.go` calls in the auth flow.
class _SessionListener extends ChangeNotifier {
  _SessionListener(this._ref) {
    _sub = _ref.listen<SessionState>(sessionProvider, (_, __) {
      notifyListeners();
    });
  }

  final Ref _ref;
  late final ProviderSubscription<SessionState> _sub;

  @override
  void dispose() {
    _sub.close();
    super.dispose();
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/api/endpoints.dart';
import '../core/auth/session.dart';
import '../features/auth/login_screen.dart';
import '../features/categories/categories_screen.dart';
import '../features/categories/category_form_screen.dart';
import '../features/company_switcher/company_switcher_screen.dart';
import '../features/customers/customer_form_screen.dart';
import '../features/customers/customers_screen.dart';
import '../features/dashboard/dashboard_screen.dart';
import '../features/journals/journal_form_screen.dart';
import '../features/journals/journals_screen.dart';
import '../features/locations/location_form_screen.dart';
import '../features/locations/locations_screen.dart';
import '../features/masters/masters_hub_screen.dart';
import '../features/payments/voucher_form_screen.dart';
import '../features/payments/vouchers_screen.dart';
import '../features/products/product_form_screen.dart';
import '../features/products/products_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/purchase_invoices/purchase_invoice_form_screen.dart';
import '../features/purchase_invoices/purchase_invoices_screen.dart';
import '../features/reports/report_view_screen.dart';
import '../features/reports/reports_screen.dart';
import '../features/sales_invoices/sales_invoice_form_screen.dart';
import '../features/sales_invoices/sales_invoices_screen.dart';
import '../features/sales_persons/sales_person_form_screen.dart';
import '../features/sales_persons/sales_persons_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/suppliers/supplier_form_screen.dart';
import '../features/suppliers/suppliers_screen.dart';
import '../features/sync/sync_screen.dart';
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
        // Signed-out users belong on the login screen; let them stay there.
        return isLogin ? null : '/login';
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
        path: '/customers',
        name: 'customers',
        builder: (_, __) => const CustomersScreen(),
      ),
      GoRoute(
        path: '/customers/add',
        name: 'customer-add',
        builder: (_, __) => const CustomerFormScreen(),
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
        path: '/sales-persons',
        name: 'sales-persons',
        builder: (_, __) => const SalesPersonsScreen(),
      ),
      GoRoute(
        path: '/sales-persons/add',
        name: 'sales-person-add',
        builder: (_, __) => const SalesPersonFormScreen(),
      ),

      // ─── Transactions (side trips off the Transactions hub) ─────
      GoRoute(
        path: '/sales-invoices',
        name: 'sales-invoices',
        builder: (_, __) => const SalesInvoicesScreen(),
      ),
      GoRoute(
        path: '/sales-invoices/add',
        name: 'sales-invoice-add',
        builder: (_, __) => const SalesInvoiceFormScreen(),
      ),
      GoRoute(
        path: '/purchase-invoices',
        name: 'purchase-invoices',
        builder: (_, __) => const PurchaseInvoicesScreen(),
      ),
      GoRoute(
        path: '/purchase-invoices/add',
        name: 'purchase-invoice-add',
        builder: (_, __) => const PurchaseInvoiceFormScreen(),
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
        path: '/journals',
        name: 'journals',
        builder: (_, __) => const JournalsScreen(),
      ),
      GoRoute(
        path: '/journals/add',
        name: 'journal-add',
        builder: (_, __) => const JournalFormScreen(),
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
        builder: (_, __) => const SyncScreen(),
      ),
      GoRoute(
        path: '/settings',
        name: 'settings-page',
        builder: (_, __) => const SettingsScreen(),
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

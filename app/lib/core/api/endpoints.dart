/// All Node-API endpoints the TallySaaS app talks to. Centralised so a
/// backend rename happens in exactly one place. Values are PATH-only
/// (no host, no `/api/v1` prefix) — the Dio base URL handles those.
class Endpoints {
  Endpoints._();

  // ─── Auth + identity ────────────────────────────────────────
  static const String login        = '/auth/login';
  static const String logout       = '/auth/logout';
  static const String me           = '/me';
  static const String myCompanies  = '/my-companies';

  // ─── Dashboard ──────────────────────────────────────────────
  static const String dashboardSummary = '/dashboard/summary';

  // ─── Config (non-master-table dropdown enums; single source) ─
  static const String configOptions = '/config/options';

  // ─── Masters ────────────────────────────────────────────────
  static const String customers    = '/customers';
  static const String suppliers    = '/suppliers';
  static const String products     = '/products';
  static const String categories   = '/categories';
  static const String locations    = '/locations';
  static const String salesPersons = '/sales-persons';

  // ─── Transactions ───────────────────────────────────────────
  static const String salesInvoices    = '/sales-invoices';
  static const String purchaseInvoices = '/purchase-invoices';
  static const String payments         = '/payments';
  static const String receipts         = '/receipts';
  static const String journals         = '/journals';
  static const String inventory        = '/inventory';

  // ─── Admin (users / roles / settings) ───────────────────────
  static const String users    = '/users';
  static const String roles    = '/roles';
  static const String settings = '/settings';

  // ─── Sync (Tally bridge bookkeeping) ────────────────────────
  static const String syncSummary = '/sync/summary';
  static const String syncLogs    = '/sync/logs';

  // ─── Reports (Tally-style registers) ────────────────────────
  static const String reportsSalesRegister = '/reports/sales-register';
  static const String reportsDayBook        = '/reports/day-book';
  static const String reportsOutstanding    = '/reports/outstanding';
  static const String reportsGstSummary     = '/reports/gst-summary';
  static const String reportsStockSummary   = '/reports/stock-summary';
  static const String reportsLedger         = '/reports/ledger';
  static const String reportsTrialBalance   = '/reports/trial-balance';
  static const String reportsProfitLoss     = '/reports/profit-loss';
  static const String reportsBalanceSheet   = '/reports/balance-sheet';
}

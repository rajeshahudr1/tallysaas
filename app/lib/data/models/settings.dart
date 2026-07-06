/// The payload of `GET /api/v1/settings`:
///
///   { company: { name, email, mobile, gst_number, pan_number,
///                financial_year, address },
///     settings: { ...flat key/value bag... } }
///
/// `company` is the editable slice of the caller's `companies` row (the seven
/// columns the controller's COMPANY_FIELDS surfaces). `settings` is a free-form
/// key→value bag (the `settings` table folded into an object); we keep it as a
/// raw map so the screen can pass it straight back on save.
///
/// pg returns text columns as-is, but bigints/jsonb scalars can arrive as
/// strings, so the field reads are defensive (mirrors `payment.dart`).
class CompanyProfile {
  const CompanyProfile({
    this.name = '',
    this.email,
    this.mobile,
    this.gstNumber,
    this.panNumber,
    this.financialYear,
    this.address,
  });

  final String name;
  final String? email;
  final String? mobile;
  final String? gstNumber;
  final String? panNumber;
  final String? financialYear;
  final String? address;

  factory CompanyProfile.fromJson(Map<String, dynamic> j) => CompanyProfile(
        name: _s(j['name']),
        email: _sn(j['email']),
        mobile: _sn(j['mobile']),
        gstNumber: _sn(j['gst_number']),
        panNumber: _sn(j['pan_number']),
        financialYear: _sn(j['financial_year']),
        address: _sn(j['address']),
      );

  static String _s(Object? v) => v == null ? '' : v.toString();
  static String? _sn(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }
}

/// One entry of the syncable-module catalog ({ key, label }) — mirrors the
/// server's api/Helpers/syncModules.js. Backs the auto push/pull module pickers.
class SyncModule {
  const SyncModule({required this.key, required this.label});
  final String key;
  final String label;

  factory SyncModule.fromJson(Map<String, dynamic> j) => SyncModule(
        key: (j['key'] ?? '').toString(),
        label: (j['label'] ?? j['key'] ?? '').toString(),
      );
}

class Settings {
  const Settings({
    required this.company,
    this.settings = const {},
    this.sync = const {},
    this.modules = const [],
  });

  /// The editable company profile.
  final CompanyProfile company;

  /// Free-form key/value settings bag, kept raw so it round-trips on save.
  final Map<String, dynamic> settings;

  /// Agent sync toggles ({sync_enabled, push_enabled, pull_enabled,
  /// auto_update, push_modules, pull_modules}) — read here for the Tally Sync
  /// tab's switches + the per-module auto-sync pickers.
  final Map<String, dynamic> sync;

  /// The full syncable-module catalog for the auto push/pull pickers.
  final List<SyncModule> modules;

  /// All module keys (the "ALL" fallback when a selection isn't configured).
  List<String> get allModuleKeys => modules.map((m) => m.key).toList();

  /// Read a module-selection list from the sync object. A missing / non-list
  /// value falls back to ALL modules (matches the server + web).
  List<String> _modList(String key) {
    final v = sync[key];
    if (v is List) return v.map((e) => e.toString()).toList();
    return allModuleKeys;
  }

  /// Selected module keys for AUTO push (Cloud→Tally). ALL when unconfigured.
  List<String> get pushModules => _modList('push_modules');

  /// Selected module keys for AUTO pull (Tally→Cloud). ALL when unconfigured.
  List<String> get pullModules => _modList('pull_modules');

  /// Read a settings-bag value as a string with a default.
  String sv(String key, [String fallback = '']) {
    final v = settings[key];
    return (v == null) ? fallback : v.toString();
  }

  /// Read a settings-bag flag (handles 'on'/'true'/1/bool).
  bool sb(String key, [bool fallback = false]) {
    final v = settings[key];
    if (v == null) return fallback;
    if (v is bool) return v;
    final s = v.toString().toLowerCase();
    return s == 'on' || s == 'true' || s == '1';
  }

  /// Read a sync flag from the sync object (default true — matches the web,
  /// which treats `!== false` as on).
  bool syncFlag(String key) => sync[key] != false;

  factory Settings.fromJson(Map<String, dynamic> j) {
    final companyJson = j['company'];
    final settingsJson = j['settings'];
    final syncJson = j['sync'];
    final modulesJson = j['modules'];
    return Settings(
      company: companyJson is Map
          ? CompanyProfile.fromJson(companyJson.cast<String, dynamic>())
          : const CompanyProfile(),
      settings: settingsJson is Map
          ? settingsJson.cast<String, dynamic>()
          : const {},
      sync: syncJson is Map ? syncJson.cast<String, dynamic>() : const {},
      modules: modulesJson is List
          ? modulesJson
              .whereType<Map>()
              .map((m) => SyncModule.fromJson(m.cast<String, dynamic>()))
              .toList()
          : const [],
    );
  }
}

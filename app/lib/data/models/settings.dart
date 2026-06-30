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

class Settings {
  const Settings({required this.company, this.settings = const {}, this.sync = const {}});

  /// The editable company profile.
  final CompanyProfile company;

  /// Free-form key/value settings bag, kept raw so it round-trips on save.
  final Map<String, dynamic> settings;

  /// Agent sync toggles ({sync_enabled, push_enabled, pull_enabled,
  /// auto_update}) — read here for the Tally Sync tab's switches.
  final Map<String, dynamic> sync;

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
    return Settings(
      company: companyJson is Map
          ? CompanyProfile.fromJson(companyJson.cast<String, dynamic>())
          : const CompanyProfile(),
      settings: settingsJson is Map
          ? settingsJson.cast<String, dynamic>()
          : const {},
      sync: syncJson is Map ? syncJson.cast<String, dynamic>() : const {},
    );
  }
}

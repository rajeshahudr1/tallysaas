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
  const Settings({required this.company, this.settings = const {}});

  /// The editable company profile.
  final CompanyProfile company;

  /// Free-form key/value settings bag, kept raw so it round-trips on save.
  final Map<String, dynamic> settings;

  factory Settings.fromJson(Map<String, dynamic> j) {
    final companyJson = j['company'];
    final settingsJson = j['settings'];
    return Settings(
      company: companyJson is Map
          ? CompanyProfile.fromJson(companyJson.cast<String, dynamic>())
          : const CompanyProfile(),
      settings: settingsJson is Map
          ? settingsJson.cast<String, dynamic>()
          : const {},
    );
  }
}

/// Typed view of the authenticated user the TallySaaS Node API returns.
///
/// Two slightly different wire shapes carry the same user, so `fromJson`
/// tolerates both:
///   • `POST /auth/login` → `data.user = {id, name, email, role, role_slug, company_id}`
///     (role + slug are flat strings)
///   • `GET /me` → `{id, name, email, role:{id, name, slug}, permissions:[…], company_id}`
///     (role is a nested object; slug lives at `role.slug`)
///
/// We normalise both into flat `role` (display name) + `roleSlug` fields so the
/// UI and guards never have to sniff dynamic types.
class AppUser {
  const AppUser({
    required this.id,
    required this.name,
    required this.email,
    required this.role,
    required this.roleSlug,
    this.companyId,
    this.permissions = const [],
    this.isSalesman = false,
    this.salesPersonId,
    this.isCustomerUser = false,
    this.customerId,
    this.license,
  });

  final int id;
  final String name;
  final String email;
  final String role;      // human-readable role name, e.g. "Administrator"
  final String roleSlug;  // machine slug, e.g. "admin"
  final int? companyId;   // active tenant; null until a company is resolved

  /// SFA — true when this user is a LINKED field salesman (a sales_persons row
  /// points user_id at them). Drives the Draft/Submit invoice buttons + the
  /// "My Field" dashboard, and mirrors the server-side "see only my invoices"
  /// scoping. From `GET /me` (`is_salesman` / `sales_person_id`).
  final bool isSalesman;
  final int? salesPersonId;

  /// Customer portal — true when this user is a LINKED customer login
  /// (customers.user_id points at them; website/API users included). The API
  /// scopes their catalog/invoices; the app mirrors the web portal UI (locked
  /// customer + rate on the invoice form, simple stats dashboard, no approvals).
  /// From `GET /me` (`is_customer_user` / `customer_id`).
  final bool isCustomerUser;
  final int? customerId;

  /// The user's licence plan summary (company-admin+): valid-until, plan limits
  /// (max companies/users) and how many company slots are used/remaining. Null
  /// for the super-admin / a user with no licence. From `.license` in login + /me.
  final LicenseInfo? license;

  /// Flat permission slugs the role grants, e.g. `customers.view`,
  /// `customers.create`. Super Admin is reported as the single wildcard `['*']`.
  /// Drives the SAME role-based menu + action gating the web does (see [can]).
  final List<String> permissions;

  /// The platform owner — sees + does everything; bypasses every RBAC check.
  bool get isSuperAdmin => roleSlug == 'super-admin' || permissions.contains('*');

  /// True when the role may perform `action` on `module` — mirrors the web's
  /// `canModule`/permission check. `module.action`, e.g. can('customers','edit').
  bool can(String module, String action) =>
      permissions.contains('*') || permissions.contains('$module.$action');

  /// True when the role has ANY permission on `module` (so the menu entry +
  /// its list screen are visible). Add/edit/delete are gated separately by [can].
  bool canModule(String module) =>
      permissions.contains('*') ||
      permissions.any((p) => p == module || p.startsWith('$module.'));

  /// True when the role can see at least one of [modules] — used to show/hide a
  /// whole nav GROUP (e.g. the Masters or Transactions tab).
  bool canAny(List<String> modules) =>
      permissions.contains('*') || modules.any(canModule);

  /// Builds an [AppUser] from either the login `user` object or the `/me`
  /// payload. Numeric ids are coerced through [_toInt] because Postgres'
  /// `pg` driver returns bigint columns as strings, not numbers.
  factory AppUser.fromJson(Map<String, dynamic> j) {
    final rawRole = j['role'];

    // role may be a flat string (login) or a nested object (/me).
    String roleName;
    String slug;
    if (rawRole is Map) {
      roleName = _str(rawRole['name']);
      slug = _str(rawRole['slug']);
    } else {
      roleName = _str(rawRole);
      slug = _str(j['role_slug']);
    }

    return AppUser(
      id: _toInt(j['id']) ?? 0,
      name: _str(j['name']),
      email: _str(j['email']),
      role: roleName,
      roleSlug: slug,
      companyId: _toInt(j['company_id']),
      permissions: _strList(j['permissions']),
      isSalesman: j['is_salesman'] == true,
      salesPersonId: _toInt(j['sales_person_id']),
      isCustomerUser: j['is_customer_user'] == true,
      customerId: _toInt(j['customer_id']),
      license: LicenseInfo.fromJson(j['license'] is Map ? Map<String, dynamic>.from(j['license'] as Map) : null),
    );
  }

  /// Round-trips back to the flat login shape — this is what we cache in
  /// secure storage (`AppConfig.kUserCache`) and re-hydrate on launch.
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'email': email,
        'role': role,
        'role_slug': roleSlug,
        'company_id': companyId,
        'permissions': permissions,
        'is_salesman': isSalesman,
        'sales_person_id': salesPersonId,
        'is_customer_user': isCustomerUser,
        'customer_id': customerId,
        'license': license?.toJson(),
      };

  /// Up-to-two-letter avatar initials derived from the display name.
  /// "Rajesh Shah" → "RS", "admin" → "AD", empty → "?".
  String get initials {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) {
      final p = parts.first;
      return (p.length >= 2 ? p.substring(0, 2) : p).toUpperCase();
    }
    return '${parts.first[0]}${parts.last[0]}'.toUpperCase();
  }

  /// Coerces a JSON value (num | String | null) into an int, returning null
  /// on missing / empty / unparseable input so we never lie with a 0.
  static int? _toInt(Object? v) {
    if (v == null) return null;
    if (v is num) return v.toInt();
    final s = v.toString().trim();
    if (s.isEmpty) return null;
    return int.tryParse(s);
  }

  static String _str(Object? v) => v == null ? '' : v.toString();

  /// Coerces a JSON value into a `List<String>` of permission slugs, tolerating
  /// a missing/null field (→ empty) or odd element types.
  static List<String> _strList(Object? v) {
    if (v is List) {
      return v.map((e) => e == null ? '' : e.toString()).where((s) => s.isNotEmpty).toList();
    }
    return const [];
  }
}

/// The signed-in user's licence plan summary (company-admin+), from `.license`
/// in the login `user` object OR the `/me` payload. Powers the app's top licence
/// strip (valid-until, company slots used/remaining, max users). Null for the
/// super-admin or a user with no licence.
class LicenseInfo {
  const LicenseInfo({
    this.validUntil,
    this.daysLeft,
    this.status,
    this.maxCompanies,
    this.maxUsers,
    this.companiesUsed,
    this.companiesRemaining,
    this.usersUsed,
    this.usersRemaining,
  });

  final String? validUntil;   // ISO date string
  final int? daysLeft;
  final String? status;
  final int? maxCompanies;
  final int? maxUsers;
  final int? companiesUsed;
  final int? companiesRemaining;
  final int? usersUsed;
  final int? usersRemaining;

  static LicenseInfo? fromJson(Map<String, dynamic>? j) {
    if (j == null) return null;
    int? i(Object? v) => v == null ? null : (v is num ? v.toInt() : int.tryParse(v.toString()));
    return LicenseInfo(
      validUntil: j['valid_until']?.toString(),
      daysLeft: i(j['days_left']),
      status: j['status']?.toString(),
      maxCompanies: i(j['max_companies']),
      maxUsers: i(j['max_users']),
      companiesUsed: i(j['companies_used']),
      companiesRemaining: i(j['companies_remaining']),
      usersUsed: i(j['users_used']),
      usersRemaining: i(j['users_remaining']),
    );
  }

  Map<String, dynamic> toJson() => {
        'valid_until': validUntil,
        'days_left': daysLeft,
        'status': status,
        'max_companies': maxCompanies,
        'max_users': maxUsers,
        'companies_used': companiesUsed,
        'companies_remaining': companiesRemaining,
        'users_used': usersUsed,
        'users_remaining': usersRemaining,
      };

  /// "8 Jul 2026" from the ISO valid_until (best-effort; null when unparseable).
  String? get validUntilLabel {
    if (validUntil == null || validUntil!.isEmpty) return null;
    final d = DateTime.tryParse(validUntil!);
    if (d == null) return null;
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${d.day} ${m[d.month - 1]} ${d.year}';
  }
}

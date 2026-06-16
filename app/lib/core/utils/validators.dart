/// Client-side validation rules that mirror the API's schemas. Keeping a
/// single source for both sides means the user sees the same error before
/// the request leaves the device — and after, if they somehow bypass the
/// client.
///
/// Each function returns either `null` (valid) or a human-readable error
/// string that drops straight into a TextFormField's `validator`.
class Validators {
  Validators._();

  static String? required(String? v, [String label = 'This field']) {
    if (v == null || v.trim().isEmpty) return '$label is required.';
    return null;
  }

  static String? email(String? v) {
    if (v == null || v.trim().isEmpty) return 'Email is required.';
    final ok = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(v.trim());
    return ok ? null : 'Enter a valid email address.';
  }

  /// Generic minimum-length check — captures the floor + a friendly label
  /// so callers can reuse it for passwords, codes, names, etc.
  static String? minLen(String? v, int min, [String label = 'This field']) {
    if (v == null || v.isEmpty) return '$label is required.';
    if (v.length < min) return '$label must be at least $min characters.';
    return null;
  }
}

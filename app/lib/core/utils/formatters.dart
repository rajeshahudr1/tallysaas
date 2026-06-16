import 'package:intl/intl.dart';

/// Money / date / name formatters used across the app. Keeping them in one
/// place means the invoice list, the dashboard tiles, and the customer
/// cards render values in identical shape — the operator never has to
/// translate between formats.
class Fmt {
  Fmt._();

  /// `₹ 12,345.00` — Indian-Rupee money with en_IN grouping (lakh/crore)
  /// and a fixed 2 decimals. Null / unparseable → an em-dash.
  static String inr(num? v) {
    if (v == null) return '—';
    final f = NumberFormat.currency(
      locale: 'en_IN',
      symbol: '₹ ',
      decimalDigits: 2,
    );
    return f.format(v);
  }

  /// A plain number with en_IN grouping and NO forced decimals — a whole
  /// number shows as `1,250`, a fractional one keeps up to 2 places (`12.5`).
  /// Used for quantities, stock, GST percents. Null → an em-dash.
  static String num0(num? v) {
    if (v == null) return '—';
    final f = (v == v.roundToDouble())
        ? NumberFormat('#,##0', 'en_IN')
        : NumberFormat('#,##0.##', 'en_IN');
    return f.format(v);
  }

  /// `dd/MM/yyyy` — accepts a DateTime or an API date string. Anything that
  /// fails to parse (null / empty / junk) renders as an em-dash so callers
  /// don't need to guard with try/catch.
  static String date(dynamic v) {
    final d = _toDate(v);
    if (d == null) return '—';
    return DateFormat('dd/MM/yyyy').format(d.toLocal());
  }

  /// Up to two uppercase initials from a name — drives avatar fallbacks.
  /// `'Rajesh Shah' → 'RS'`, `'rajesh' → 'R'`, empty → `'?'`.
  static String initials(String name) {
    final parts = name
        .trim()
        .split(RegExp(r'\s+'))
        .where((p) => p.isNotEmpty)
        .toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first[0].toUpperCase();
    return (parts.first[0] + parts.last[0]).toUpperCase();
  }

  /// Best-effort coercion of the various shapes the API hands us (DateTime,
  /// ISO string, epoch-ish string) into a DateTime, or null on failure.
  static DateTime? _toDate(dynamic v) {
    if (v == null) return null;
    if (v is DateTime) return v;
    final s = v.toString().trim();
    if (s.isEmpty) return null;
    return DateTime.tryParse(s);
  }
}

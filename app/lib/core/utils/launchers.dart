import 'package:url_launcher/url_launcher.dart';

/// Small helpers for the field-sales screens to open external apps:
/// dial a number, open WhatsApp, or show a lat/lng on a map. Each returns
/// `true` if something was launched, `false` otherwise (never throws).
class Launch {
  Launch._();

  static String _digits(String s) => s.replaceAll(RegExp(r'[^0-9+]'), '');

  static Future<bool> call(String? mobile) async {
    final n = _digits(mobile ?? '');
    if (n.isEmpty) return false;
    return _open(Uri(scheme: 'tel', path: n));
  }

  /// Opens WhatsApp chat with the number. Adds the country code (91) when a bare
  /// 10-digit Indian mobile is given.
  static Future<bool> whatsapp(String? mobile) async {
    var n = _digits(mobile ?? '').replaceAll('+', '');
    if (n.isEmpty) return false;
    if (n.length == 10) n = '91$n';
    return _open(Uri.parse('https://wa.me/$n'));
  }

  static Future<bool> map(double? lat, double? lng) async {
    if (lat == null || lng == null) return false;
    return _open(Uri.parse('https://maps.google.com/?q=$lat,$lng'));
  }

  static Future<bool> _open(Uri uri) async {
    try {
      if (await canLaunchUrl(uri)) {
        return launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (_) {}
    return false;
  }
}

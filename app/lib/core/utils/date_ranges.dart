/// core/utils/date_ranges.dart
///
/// Dart port of `web/lib/date-ranges.js` — the dashboard Summary panel's nine
/// date-range presets. PURE: every function takes "now" as an argument, so the
/// presets are testable and the app never depends on ambient clock state
/// mid-build.
///
/// Financial-year conventions (Indian FY): a year runs 1 Apr → 31 Mar, and
/// quarters are the FY quarters (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar). Weeks
/// run Monday → Monday, matching the web.
///
/// Labels render like "This Year (1st Apr '26 - 31st Mar '27)" — identical
/// strings to the web's <select>, so the two dashboards read the same.
library;

const List<String> _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// One preset: the key sent to the API, its human label, and its ISO bounds.
class DateRange {
  const DateRange({
    required this.value,
    required this.label,
    required this.from,
    required this.to,
  });

  final String value;
  final String label;
  final String from; // YYYY-MM-DD
  final String to;   // YYYY-MM-DD
}

class DateRanges {
  DateRanges._();

  /// Preset keys, in the order the web's <select> lists them.
  static const List<String> values = [
    'today', 'yesterday', 'this_week', 'last_week',
    'this_month', 'last_month', 'this_quarter',
    'this_year', 'last_year',
  ];

  static const String defaultValue = 'this_year';

  // 1 → "1st", 2 → "2nd", 3 → "3rd", 11..13 → "th", else by last digit.
  static String _ordinal(int n) {
    final rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return '${n}th';
    switch (n % 10) {
      case 1: return '${n}st';
      case 2: return '${n}nd';
      case 3: return '${n}rd';
      default: return '${n}th';
    }
  }

  /// DateTime → 'YYYY-MM-DD' from LOCAL components (never toIso8601String on a
  /// UTC value, which would shift the date back for a positive offset like IST).
  static String iso(DateTime d) {
    String p(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)}';
  }

  /// DateTime → "3rd Aug '26".
  static String pretty(DateTime d) {
    final yy = d.year.toString().substring(2);
    return "${_ordinal(d.day)} ${_months[d.month - 1]} '$yy";
  }

  static DateTime _day(DateTime d) => DateTime(d.year, d.month, d.day);
  static DateTime _addDays(DateTime d, int n) => DateTime(d.year, d.month, d.day + n);

  /// Most recent Monday STRICTLY BEFORE [d] — a Monday belongs to the week that
  /// opened the *previous* Monday, exactly as the web computes it.
  static DateTime _startOfWeek(DateTime d) {
    final dow = d.weekday % 7;          // Dart: Mon=1..Sun=7 → JS: Sun=0..Sat=6
    final back = ((dow + 6) % 7) == 0 ? 7 : ((dow + 6) % 7);
    return _addDays(d, -back);
  }

  /// The calendar year in which this date's financial year STARTED.
  /// Jan/Feb/Mar belong to the FY that began the previous April.
  static int _fyStartYear(DateTime d) => d.month >= 4 ? d.year : d.year - 1;

  /// Financial quarter index 0..3 (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar).
  static int _fyQuarter(DateTime d) => ((d.month - 4 + 12) % 12) ~/ 3;

  static DateRange _span(String value, String title, DateTime from, DateTime to) =>
      DateRange(
        value: value,
        label: '$title (${pretty(from)} - ${pretty(to)})',
        from: iso(from),
        to: iso(to),
      );

  static DateRange _single(String value, String title, DateTime day) => DateRange(
        value: value,
        label: '$title (${pretty(day)})',
        from: iso(day),
        to: iso(day),
      );

  /// All nine presets for a given "now", in [values] order.
  static List<DateRange> build(DateTime now) {
    final d = _day(now);
    final weekStart = _startOfWeek(d);
    final fyStart = _fyStartYear(d);
    final q = _fyQuarter(d);
    final qStart = DateTime(fyStart, 4 + q * 3, 1);
    final qEnd = DateTime(fyStart, 4 + q * 3 + 3, 0); // day 0 = last of prev month

    return [
      _single('today', 'Today', d),
      _single('yesterday', 'Yesterday', _addDays(d, -1)),
      _span('this_week', 'This Week', weekStart, d),
      _span('last_week', 'Last Week', _addDays(weekStart, -7), weekStart),
      _span('this_month', 'This Month',
          DateTime(d.year, d.month, 1), DateTime(d.year, d.month + 1, 0)),
      _span('last_month', 'Last Month',
          DateTime(d.year, d.month - 1, 1), DateTime(d.year, d.month, 0)),
      _span('this_quarter', 'This Quarter', qStart, qEnd),
      _span('this_year', 'This Year',
          DateTime(fyStart, 4, 1), DateTime(fyStart + 1, 3, 31)),
      _span('last_year', 'Last Year',
          DateTime(fyStart - 1, 4, 1), DateTime(fyStart, 3, 31)),
    ];
  }

  /// Resolve one preset by key. An unknown key falls back to [defaultValue],
  /// so a stale saved selection can never produce a null range.
  static DateRange resolve(String value, DateTime now) {
    final all = build(now);
    return all.firstWhere(
      (r) => r.value == value,
      orElse: () => all.firstWhere((r) => r.value == defaultValue),
    );
  }
}

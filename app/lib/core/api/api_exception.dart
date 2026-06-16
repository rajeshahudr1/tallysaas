/// Typed error surface for every API call. The Node API returns a uniform
/// envelope `{ status, show, msg, data }` — we collapse Dio's network /
/// server / parse failures + the in-envelope error status into one class
/// the UI can render via `error.message` without sniffing types.
class ApiException implements Exception {
  ApiException(
    this.message, {
    this.httpStatus = 0,
    this.code,
    this.details,
  });

  /// User-facing message (already friendly — controllers can drop straight
  /// into snackbars / error states). Sourced from the envelope's `msg`.
  final String message;

  /// HTTP / envelope status, when known. 0 = network error / no response.
  final int httpStatus;

  /// Optional machine-readable code (e.g. 'unauthenticated', 'validation',
  /// 'timeout', 'network').
  final String? code;

  /// Optional details map (e.g. per-field validation errors).
  final Map<String, dynamic>? details;

  bool get isUnauthorized => httpStatus == 401;
  bool get isNetwork      => httpStatus == 0;
  bool get isValidation   => httpStatus == 422;

  @override
  String toString() => 'ApiException($httpStatus, $code): $message';
}

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/token_storage.dart';
import '../constants.dart';
import 'api_exception.dart';

/// Thin Dio wrapper that every repository talks through. Responsibilities:
///
///   1. Set the API base URL (`AppConfig.apiBase + /api/v1`).
///   2. Attach `Authorization: Bearer <jwt>` when a token is stored.
///   3. Attach `X-Company-Id` so the server scopes every query to the
///      active tenant. (TallySaaS scopes by company *id*, not slug — the
///      company switcher is purely client-side: it just rewrites this id.)
///   4. Unwrap the API envelope `{ status, show, msg, data }` → return
///      `data` directly, or throw `ApiException` if `status != 200`.
///   5. Turn Dio's transport errors (timeout, DNS, no response) into the
///      same `ApiException` so UI code only catches one type.
///
/// The instance is exposed via Riverpod so tests can override it with a
/// MockDio.
class ApiClient {
  ApiClient(this._dio, this._tokens);

  final Dio _dio;
  final TokenStorage _tokens;

  /// Factory used by the Riverpod provider — builds a Dio with sensible
  /// defaults and attaches the auth + envelope interceptors.
  factory ApiClient.create(TokenStorage tokens) {
    final dio = Dio(BaseOptions(
      baseUrl: '${AppConfig.apiBase}${AppConfig.apiPrefix}',
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      sendTimeout:    const Duration(seconds: 30),
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/json',
      },
      // Don't auto-throw on non-2xx — we surface the envelope's `status`
      // field instead. Dio errors are only thrown for transport problems
      // and 5xx server faults.
      validateStatus: (s) => s != null && s < 500,
    ));

    final client = ApiClient(dio, tokens);
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: client._onRequest,
    ));
    return client;
  }

  Future<void> _onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await _tokens.readToken();
    if (token != null && token.isNotEmpty) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    // The active company id is the tenant key — every scoped query reads it.
    final companyId = await _tokens.readCompanyId();
    if (companyId != null && companyId.isNotEmpty) {
      options.headers['X-Company-Id'] = companyId;
    }
    return handler.next(options);
  }

  // ── Public HTTP verbs (envelope-aware) ─────────────────────

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) =>
      _send('GET', path, query: query);

  Future<dynamic> post(String path, {Object? body, Map<String, dynamic>? query}) =>
      _send('POST', path, body: body, query: query);

  Future<dynamic> put(String path, {Object? body, Map<String, dynamic>? query}) =>
      _send('PUT', path, body: body, query: query);

  Future<dynamic> patch(String path, {Object? body, Map<String, dynamic>? query}) =>
      _send('PATCH', path, body: body, query: query);

  Future<dynamic> delete(String path, {Object? body, Map<String, dynamic>? query}) =>
      _send('DELETE', path, body: body, query: query);

  /// Multipart upload — used by any endpoint that accepts a file (e.g. a
  /// company logo or attachment). Wraps the same envelope handling so
  /// callers don't have to special-case the response.
  Future<dynamic> uploadMultipart(
    String path, {
    required FormData form,
  }) async {
    try {
      final resp = await _dio.post<dynamic>(
        path,
        data: form,
        options: Options(
          contentType: 'multipart/form-data',
          // The request interceptor already added the auth + company
          // headers; null the JSON Content-Type so Dio derives the
          // multipart boundary from the FormData itself.
          headers: {'Content-Type': null},
        ),
      );
      return _unwrap(resp);
    } on DioException catch (e) {
      throw _fromDioError(e);
    }
  }

  Future<dynamic> _send(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
  }) async {
    try {
      final resp = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(method: method),
      );
      return _unwrap(resp);
    } on DioException catch (e) {
      throw _fromDioError(e);
    }
  }

  /// Turns the Node envelope into either `data` (success) or an
  /// `ApiException` (any non-200 status). Networking issues — captured
  /// by the `DioException` branch above — never reach this method.
  dynamic _unwrap(Response<dynamic> resp) {
    final body = resp.data;
    if (body is! Map) {
      throw ApiException(
        'Unexpected response shape from server.',
        httpStatus: resp.statusCode ?? 0,
      );
    }
    final status = (body['status'] is int)
        ? body['status'] as int
        : resp.statusCode ?? 0;
    if (status == 200) {
      return body['data'];
    }
    throw ApiException(
      (body['msg'] as String?) ?? 'Request failed (HTTP $status).',
      httpStatus: status,
      details: (body['details'] is Map)
          ? (body['details'] as Map).cast<String, dynamic>()
          : null,
    );
  }

  ApiException _fromDioError(DioException e) {
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.sendTimeout ||
        e.type == DioExceptionType.receiveTimeout) {
      return ApiException(
        'The server took too long to respond. Please try again.',
        httpStatus: 0,
        code: 'timeout',
      );
    }
    if (e.type == DioExceptionType.connectionError ||
        e.type == DioExceptionType.unknown) {
      return ApiException(
        'Could not reach the server. Check your connection.',
        httpStatus: 0,
        code: 'network',
      );
    }
    final status = e.response?.statusCode ?? 0;
    final body   = e.response?.data;
    final msg    = (body is Map && body['msg'] is String)
        ? body['msg'] as String
        : 'Something went wrong. Please try again.';
    return ApiException(msg, httpStatus: status);
  }
}

// ─── Providers ─────────────────────────────────────────────────
// Token storage is async (SecureStorage on Android/iOS); we expose the
// ApiClient as a synchronous `Provider` because creating the Dio instance
// is sync and TokenStorage reads are deferred into the interceptor.

final apiClientProvider = Provider<ApiClient>((ref) {
  final tokens = ref.watch(tokenStorageProvider);
  return ApiClient.create(tokens);
});

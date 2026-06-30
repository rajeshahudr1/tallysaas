import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:printing/printing.dart';

import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';

/// An app-bar Print/PDF action: fetches a server-rendered, data-only PDF from
/// [path] (e.g. '/sales-invoices/123/pdf') and opens the native print / save
/// sheet. Reusable across invoice + voucher + report detail screens.
class PdfActionButton extends ConsumerStatefulWidget {
  const PdfActionButton({super.key, required this.path, required this.name});

  final String path; // PDF endpoint, e.g. '/sales-invoices/123/pdf'
  final String name; // document name shown in the print sheet

  @override
  ConsumerState<PdfActionButton> createState() => _PdfActionButtonState();
}

class _PdfActionButtonState extends ConsumerState<PdfActionButton> {
  bool _busy = false;

  Future<void> _print() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final bytes = await ref.read(apiClientProvider).getBytes(widget.path);
      if (!mounted) return;
      await Printing.layoutPdf(
        name: widget.name,
        onLayout: (_) async => Uint8List.fromList(bytes),
      );
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not open the PDF. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _snack(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: _busy
          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : const Icon(Icons.picture_as_pdf_outlined),
      tooltip: 'Print / PDF',
      onPressed: _busy ? null : _print,
    );
  }
}

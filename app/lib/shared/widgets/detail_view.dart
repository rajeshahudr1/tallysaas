import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import 'confirm_dialog.dart';
import 'error_state.dart';
import 'loading_state.dart';

/// Section header on a detail (View) screen.
class DetailSection extends StatelessWidget {
  const DetailSection(this.title, {super.key, this.first = false});
  final String title;
  final bool first;
  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(
            top: first ? 0 : AppSpacing.lg16, bottom: AppSpacing.sm8),
        child: Text(title,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: AppColors.primary, fontWeight: FontWeight.w700)),
      );
}

/// Label/value row — hidden entirely when the value is null/blank so a detail
/// shows only what's actually set (no rows of dashes).
class DetailRow extends StatelessWidget {
  const DetailRow(this.label, this.value, {super.key});
  final String label;
  final String? value;
  @override
  Widget build(BuildContext context) {
    if (value == null || value!.trim().isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 130,
            child: Text(label,
                style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(child: Text(value!, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

/// Generic master detail / View scaffold: loads a record, renders an app bar
/// with **Edit + Delete gated by the role's `<module>.edit` / `.delete`**
/// permissions (mirrors the web's row actions), then the caller's field rows.
/// Pops `true` after a delete so the list refreshes; re-loads after an edit.
class DetailScaffold<T> extends ConsumerStatefulWidget {
  const DetailScaffold({
    super.key,
    required this.title,
    required this.module,
    required this.load,
    required this.onDelete,
    this.editRoute,
    this.extraActions,
    required this.deleteTitle,
    required this.deleteMessage,
    required this.deletedMessage,
    required this.bodyBuilder,
  });

  final String title;
  final String module; // permission slug, e.g. 'products'
  final Future<T> Function() load;
  final Future<void> Function() onDelete; // performs the repo delete
  final String? editRoute; // e.g. '/products/12/edit'; null → no Edit action (e.g. invoices)
  final List<Widget>? extraActions; // extra appbar actions (e.g. a Print/PDF button)
  final String deleteTitle;
  final String deleteMessage;
  final String deletedMessage;
  final List<Widget> Function(BuildContext, T) bodyBuilder;

  @override
  ConsumerState<DetailScaffold<T>> createState() => _DetailScaffoldState<T>();
}

class _DetailScaffoldState<T> extends ConsumerState<DetailScaffold<T>> {
  late Future<T> _future;
  bool _deleting = false;

  @override
  void initState() {
    super.initState();
    _future = widget.load();
  }

  void _reload() => setState(() => _future = widget.load());

  Future<void> _delete() async {
    final ok = await ConfirmDialog.show(
      context,
      title: widget.deleteTitle,
      message: widget.deleteMessage,
      confirmLabel: 'Delete',
      danger: true,
    );
    if (!ok || _deleting) return;
    setState(() => _deleting = true);
    try {
      await widget.onDelete();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(widget.deletedMessage)));
      context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (e) {
      _snack('Could not delete: $e');
    } finally {
      if (mounted) setState(() => _deleting = false);
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
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canEdit = user?.can(widget.module, 'edit') ?? false;
    final canDelete = user?.can(widget.module, 'delete') ?? false;

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          ...?widget.extraActions,
          if (canEdit && widget.editRoute != null)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit',
              onPressed: () async {
                final saved = await context.push<bool>(widget.editRoute!);
                if (saved == true) _reload();
              },
            ),
          if (canDelete)
            IconButton(
              icon: _deleting
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.delete_outline),
              tooltip: 'Delete',
              onPressed: _deleting ? null : _delete,
            ),
        ],
      ),
      body: FutureBuilder<T>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const LoadingState(message: 'Loading…');
          }
          if (snap.hasError) {
            final e = snap.error;
            return ErrorState(
              e is ApiException ? e.message : 'Could not load.',
              onRetry: _reload,
            );
          }
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.lg16),
            children: widget.bodyBuilder(context, snap.data as T),
          );
        },
      ),
    );
  }
}

/// Header row for a detail screen: big name on the left, an optional trailing
/// widget (e.g. a StatusPill) on the right.
class DetailHeader extends StatelessWidget {
  const DetailHeader(this.name, {super.key, this.trailing});
  final String name;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.lg16),
        child: Row(
          children: [
            Expanded(child: Text(name, style: Theme.of(context).textTheme.headlineSmall)),
            if (trailing != null) trailing!,
          ],
        ),
      );
}

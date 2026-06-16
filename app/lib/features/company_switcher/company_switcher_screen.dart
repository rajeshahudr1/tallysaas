import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/endpoints.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/session.dart';
import '../../data/models/paged.dart';
import '../../data/repositories/options_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Switch Company — lists every company the signed-in user belongs to
/// (`GET /my-companies`) and lets them re-point the active tenant. The
/// currently-active company (derived from the session user's `companyId`)
/// is flagged with a check. Tapping a different company rewrites the
/// `X-Company-Id` scope via `authService.switchCompany`, which re-fetches
/// `/me` and flips the session so the router re-renders.
class CompanySwitcherScreen extends ConsumerStatefulWidget {
  const CompanySwitcherScreen({super.key});

  @override
  ConsumerState<CompanySwitcherScreen> createState() =>
      _CompanySwitcherScreenState();
}

class _CompanySwitcherScreenState
    extends ConsumerState<CompanySwitcherScreen> {
  // Id of the company a switch is currently in-flight for (drives the
  // per-tile spinner + blocks double taps). null when idle.
  int? _switchingId;

  /// Resolve the active company id from the signed-in session user.
  int? _activeCompanyId() {
    final session = ref.read(sessionProvider);
    return switch (session) {
      SessionSignedIn(:final user) => user.companyId,
      _ => null,
    };
  }

  Future<void> _onTap(OptionItem company) async {
    if (_switchingId != null) return; // a switch is already running

    // No-op when tapping the already-active company — just pop back.
    if (company.id == _activeCompanyId()) {
      if (mounted) context.pop();
      return;
    }

    setState(() => _switchingId = company.id);
    try {
      await ref.read(authServiceProvider).switchCompany(company.id.toString());
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('Switched to ${company.name}')));
      context.pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _switchingId = null);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('Could not switch: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final companiesAsync = ref.watch(optionsProvider(Endpoints.myCompanies));
    final activeId = _activeCompanyId();

    return Scaffold(
      appBar: AppBar(title: const Text('Switch Company')),
      body: companiesAsync.when(
        loading: () => const LoadingState(message: 'Loading companies…'),
        error: (e, _) => ErrorState(
          e.toString(),
          onRetry: () => ref.invalidate(optionsProvider(Endpoints.myCompanies)),
        ),
        data: (companies) {
          if (companies.isEmpty) {
            return const EmptyState(
              'No companies available.',
              icon: Icons.business_outlined,
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12,
              AppSpacing.md12,
              AppSpacing.md12,
              AppSpacing.xxl32,
            ),
            itemCount: companies.length,
            separatorBuilder: (_, __) =>
                const SizedBox(height: AppSpacing.sm8),
            itemBuilder: (context, i) {
              final c = companies[i];
              return _CompanyTile(
                company: c,
                active: c.id == activeId,
                switching: _switchingId == c.id,
                onTap: () => _onTap(c),
              );
            },
          );
        },
      ),
    );
  }
}

class _CompanyTile extends StatelessWidget {
  const _CompanyTile({
    required this.company,
    required this.active,
    required this.switching,
    required this.onTap,
  });

  final OptionItem company;
  final bool active;
  final bool switching;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Icon(
            Icons.business,
            color: active ? AppColors.primary : AppColors.text3,
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Text(
              company.name,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: active ? FontWeight.w600 : FontWeight.w500,
              ),
            ),
          ),
          if (switching)
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            )
          else if (active)
            const Icon(Icons.check_circle, color: AppColors.success),
        ],
      ),
    );
  }
}

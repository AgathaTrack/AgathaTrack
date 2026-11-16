import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:pet_profile_app/l10n/app_localizations.dart';
import 'package:pet_profile_app/features/pet_care/pet_care.dart';
import 'package:pet_profile_app/features/health_tracking/health_tracking.dart';

/// Needs attention fallback on the Care item view (spec §4.3).
///
/// Only rendered when `CareItemNeedsAttentionSection` is not: the item is
/// paused (banner only, D-CIE-043) or the entry has no server schedule
/// (`as_of` missing — read-only legacy summary). Per-occurrence and bulk
/// actions live only on `CareItemNeedsAttentionSection`.
class CareItemDatesSection extends StatelessWidget {
  const CareItemDatesSection({
    super.key,
    required this.entry,
    required this.muted,
  });

  final HealthEntry entry;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    if (!entry.isPaused) {
      return _LegacyDatesSummary(entry: entry, muted: muted);
    }
    final l = AppLocalizations.of(context)!;
    return CareItemModule(
      key: const Key('care_item_needs_attention_section'),
      semanticLabel: l.careItemNeedsAttentionTitle,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          CareItemSectionHeader(
            title: l.careItemNeedsAttentionTitle,
            icon: Icons.flag_outlined,
          ),
          const SizedBox(height: 12),
          _PausedAttentionBanner(entry: entry, muted: muted),
        ],
      ),
    );
  }
}

class _LegacyDatesSummary extends StatelessWidget {
  const _LegacyDatesSummary({required this.entry, required this.muted});

  final HealthEntry entry;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final status = formatCareEventStatusLine(entry, l, colorScheme);

    return Column(
      key: const Key('care_item_dates_section'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(
            l.careItemDatesTitle,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
              color: muted ? colorScheme.onSurfaceVariant : null,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Container(
          key: Key('care_item_dates_summary_${entry.id}'),
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: colorScheme.outlineVariant),
          ),
          child: CareEventStatusLineView(
            status: status,
            theme: theme,
            colorScheme: colorScheme,
          ),
        ),
      ],
    );
  }
}

class _PausedAttentionBanner extends StatelessWidget {
  const _PausedAttentionBanner({required this.entry, required this.muted});

  final HealthEntry entry;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final since = entry.pausedSince;
    final until = entry.schedule?.pausedUntil;
    final String line;
    if (until != null) {
      line = l.careItemPausedUntil(DateFormat.yMMMd().format(until));
    } else if (since != null) {
      line = l.careItemPausedSince(DateFormat.yMMMd().format(since));
    } else {
      line = l.careItemPausedStatus;
    }

    return Semantics(
      identifier: 'care_item_paused_banner',
      child: Container(
        key: const Key('care_item_paused_banner'),
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(CareSurfaceTokens.actionRadius),
          border: Border.all(color: CareSurfaceTokens.moduleBorder()),
        ),
        child: Text(
          line,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: muted ? colorScheme.onSurfaceVariant : colorScheme.onSurface,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

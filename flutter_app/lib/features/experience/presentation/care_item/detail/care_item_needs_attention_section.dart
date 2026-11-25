import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import 'package:pet_profile_app/core/providers/analytics_providers.dart';
import 'package:pet_profile_app/core/widgets/app_undo_snackbar.dart';
import 'package:pet_profile_app/features/care_item/care_item.dart';
import 'package:pet_profile_app/features/health_tracking/health_tracking.dart';
import 'package:pet_profile_app/features/pet_care/pet_care.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

import 'care_item_attention_occurrence_row.dart';
import 'care_item_bulk_action_bar.dart';
import 'care_item_bulk_selection_scope.dart';
import 'care_item_upcoming_group.dart';

/// Needs attention on the Care Item view: started occurrences, scoped bulk
/// actions, then upcoming preview (care-item-bulk-scope-spec).
class CareItemNeedsAttentionSection extends ConsumerStatefulWidget {
  const CareItemNeedsAttentionSection({
    super.key,
    required this.entry,
    required this.schedule,
    required this.muted,
  });

  final HealthEntry entry;
  final CareItemSchedule schedule;
  final bool muted;

  @override
  ConsumerState<CareItemNeedsAttentionSection> createState() =>
      _CareItemNeedsAttentionSectionState();
}

class _CareItemNeedsAttentionSectionState
    extends ConsumerState<CareItemNeedsAttentionSection> {
  bool _busy = false;

  CareItemSchedule get _s => widget.schedule;

  Future<void> _refresh() async {
    await ref.read(careDataChangedProvider)();
  }

  Future<void> _bulk({required bool done, List<String>? occurrenceIds}) async {
    if (_busy) return;
    final l = AppLocalizations.of(context)!;
    final groups = partitionOpenOccurrences(_s);
    final started = sortStartedOpenOccurrences(groups.started);
    final ids =
        occurrenceIds ?? started.map((o) => o.id).toList(growable: false);
    if (ids.length < 2) return;
    setState(() => _busy = true);
    final service = ref.read(careCompletionServiceProvider);
    final outcome = await service.resolveStack(
      entryId: _s.entryId,
      given: done ? ids : const [],
      notGiven: done ? const [] : ids,
    );
    await _refresh();
    if (!mounted) return;
    setState(() => _busy = false);
    final messenger = ScaffoldMessenger.of(context)..hideCurrentSnackBar();
    switch (outcome) {
      case CareFailed():
        messenger.showSnackBar(SnackBar(content: Text(l.careCommandFailed)));
        return;
      case CareSucceeded(:final value):
        final aggregate = value;
        if (aggregate.stackChangedCount == 0 && aggregate.ignoredIds.isEmpty) {
          messenger.showSnackBar(SnackBar(content: Text(l.careAlreadyUpdated)));
          return;
        }
        ref.read(analyticsServiceProvider).capture('care_stack_resolved', {
          'count': aggregate.stackChangedCount,
          'ignored': aggregate.ignoredIds.length,
          'done': done,
        });
        final message = Semantics(
          identifier: 'care_stack_snackbar',
          child: Text(
            careStackSuccessMessage(
              l,
              done: done,
              result: aggregate,
              itemName: _s.name,
            ),
          ),
        );
        final undoToken = aggregate.undoToken;
        if (undoToken == null) {
          messenger.showAppSnackBar(
            snackBarKey: const Key('care_stack_snackbar'),
            content: message,
          );
        } else {
          messenger.showUndoSnackBar(
            snackBarKey: const Key('care_stack_snackbar'),
            content: message,
            undoLabel: l.snackbarUndo,
            onUndo: () async {
              await service.undo(entryId: _s.entryId, undoToken: undoToken);
              await _refresh();
            },
          );
        }
        CareItemBulkSelectionScope.maybeOf(context)?.clearAfterBulk();
    }
  }

  Future<void> _skipRow(OpenOccurrence occurrence) async {
    if (_busy) return;
    final l = AppLocalizations.of(context)!;
    setState(() => _busy = true);
    final service = ref.read(careCompletionServiceProvider);
    final outcome = await service.skip(
      entryId: _s.entryId,
      occurrenceId: occurrence.id,
    );
    await _refresh();
    if (!mounted) return;
    setState(() => _busy = false);
    final messenger = ScaffoldMessenger.of(context)..hideCurrentSnackBar();
    switch (outcome) {
      case CareSucceeded(:final value):
        final skipped = Text(l.careSkipped(_s.name));
        if (value.undoToken == null) {
          messenger.showAppSnackBar(content: skipped);
        } else {
          messenger.showUndoSnackBar(
            content: skipped,
            undoLabel: l.snackbarUndo,
            onUndo: () async {
              await service.undo(
                entryId: _s.entryId,
                undoToken: value.undoToken,
              );
              await _refresh();
            },
          );
        }
      case CareFailed(failure: CareNotOpenFailure()):
        messenger.showSnackBar(SnackBar(content: Text(l.careAlreadyUpdated)));
      case CareFailed():
        messenger.showSnackBar(SnackBar(content: Text(l.careCommandFailed)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final groups = partitionOpenOccurrences(_s);
    final started = sortStartedOpenOccurrences(groups.started);
    final upcoming = sortUpcomingOpenOccurrences(groups.upcoming);
    final estimated = _s.estimatedNext;
    final showBulk = started.length >= 2 && isStack(_s) && !widget.muted;
    final rowMuted = widget.muted || _busy;
    final selection = CareItemBulkSelectionScope.maybeOf(context);
    final selectionMode = selection?.selectionMode ?? false;
    final showBulkBar = showBulk && !selectionMode;
    final showSelectToggle = showBulk && selection != null;

    if (selection != null) {
      selection.bindStickyActions(
        muted: rowMuted,
        onMarkSelected: () => _bulk(
          done: true,
          occurrenceIds: selection.selectedIds.toList(growable: false),
        ),
        onSkipSelected: () => _bulk(
          done: false,
          occurrenceIds: selection.selectedIds.toList(growable: false),
        ),
      );
    }

    return Semantics(
      identifier: 'care_item_needs_attention_section',
      child: CareItemModule(
        key: const Key('care_item_needs_attention_section'),
        semanticLabel: l.careItemNeedsAttentionTitle,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            CareItemSectionHeader(
              title: l.careItemNeedsAttentionTitle,
              icon: Icons.flag_outlined,
              trailing: showSelectToggle
                  ? TextButton(
                      key: const Key('care_item_bulk_selection_toggle'),
                      onPressed: rowMuted
                          ? null
                          : selection?.toggleSelectionMode,
                      child: Text(
                        selectionMode
                            ? l.cancel
                            : l.careItemBulkSelectionMode,
                      ),
                    )
                  : null,
            ),
            const SizedBox(height: 8),
            for (final occ in started)
              CareItemAttentionOccurrenceRow(
                entry: widget.entry,
                schedule: _s,
                occurrence: occ,
                muted: rowMuted,
                onChanged: _refresh,
                onSkip: () => _skipRow(occ),
                selectionMode: selectionMode,
                selected: selection?.selectedIds.contains(occ.id) ?? false,
                onSelectionChanged: selection == null
                    ? null
                    : (value) => selection.setSelected(occ.id, value),
              ),
            if (showBulkBar) ...[
              const SizedBox(height: 12),
              CareItemBulkActionBar(
                count: started.length,
                muted: rowMuted,
                onMarkAllDone: () => _bulk(done: true),
                onSkipAll: () => _bulk(done: false),
              ),
            ],
            CareItemUpcomingGroup(
              entry: widget.entry,
              schedule: _s,
              occurrences: upcoming,
              muted: rowMuted,
            ),
            if (estimated != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  l.careEstimatedNext(DateFormat.MMMd().format(estimated.date)),
                  key: const Key('care_item_estimated_next'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

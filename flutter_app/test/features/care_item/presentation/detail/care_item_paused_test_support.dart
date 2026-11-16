import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// CARE-ITEM-R-026: no per-occurrence or bulk action keys for [occurrenceId].
void expectNoOccurrenceActions(String occurrenceId) {
  for (final key in [
    'care_item_occurrence_done_$occurrenceId',
    'care_item_occurrence_mark_done_$occurrenceId',
    'care_item_occurrence_skip_$occurrenceId',
    'care_item_occurrence_reschedule_$occurrenceId',
    'care_item_skip_all_missed',
    'care_item_bulk_mark_done',
    'care_item_bulk_skip',
  ]) {
    expect(find.byKey(Key(key)), findsNothing, reason: key);
  }
}

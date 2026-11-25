import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:pet_profile_app/features/pet_profile/data/datasources/pet_remote_datasource.dart';
import 'package:pet_profile_app/features/pet_profile/data/models/pet_model.dart';

void main() {
  test('createPet does not send vetId (R-01a) but still reads it back', () async {
    final captured = <String>[];
    final ds = PetRemoteDataSourceImpl(
      baseUrl: 'http://test.local',
      client: _CaptureClient(captured),
    );

    final created = await ds.createPet(
      const PetModel(
        id: 'pet-1',
        name: 'Rex',
        species: 'Dog',
        vetId: 'legacy-vet-1',
      ),
      'token',
    );

    expect(captured, hasLength(1));
    final body = jsonDecode(captured.first) as Map<String, dynamic>;
    expect(body.containsKey('vetId'), isFalse);
    expect(body['name'], 'Rex');
    expect(body['species'], 'Dog');
    // Reads are unchanged: the server's response still populates vetId.
    expect(created.vetId, 'legacy-vet-1');
  });

  test('updatePet does not send vetId (R-01a regression guard)', () async {
    final captured = <String>[];
    final ds = PetRemoteDataSourceImpl(
      baseUrl: 'http://test.local',
      client: _CaptureClient(captured),
    );

    await ds.updatePet(
      const PetModel(
        id: 'pet-1',
        name: 'Rex',
        species: 'Dog',
        vetId: 'legacy-vet-1',
      ),
      'token',
    );

    final body = jsonDecode(captured.first) as Map<String, dynamic>;
    expect(body.containsKey('vetId'), isFalse);
  });
}

class _CaptureClient extends http.BaseClient {
  _CaptureClient(this.captured);

  final List<String> captured;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request is http.Request) {
      captured.add(request.body);
    }
    return http.StreamedResponse(
      Stream.value(
        utf8.encode(
          '{"id":"pet-1","name":"Rex","species":"Dog","vetId":"legacy-vet-1"}',
        ),
      ),
      200,
      headers: {'content-type': 'application/json'},
    );
  }
}

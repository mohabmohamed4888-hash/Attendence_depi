import json
import os
from datetime import date

PREFIX = '@@PROGRESS '
TARGET = json.loads(os.getenv('RETRY_SESSION') or 'null')
END_DATE = os.getenv('END_AT_DATE', '')
START_DATE = os.getenv('START_FROM_DATE', '')
TRACK = ''

def emit(kind, **values):
    print(PREFIX + json.dumps({'kind': kind, 'track': TRACK, **values}, default=str, ensure_ascii=False), flush=True)

def in_scope(item):
    d = str(item.get('date') or '')
    if START_DATE and d and d < START_DATE:
        return False
    if END_DATE and d and d > END_DATE:
        return False
    if TARGET:
        return d == TARGET['date'] and ' '.join(item.get('title', '').split()).casefold() == ' '.join(TARGET['title'].split()).casefold()
    return True

def select(items):
    return [item for item in items if in_scope(item)]

def session(group, item, phase, status, reason=''):
    emit('session', group=group, date=str(item.get('date') or ''), title=item.get('title', ''),
         phase=phase, status=status, reason=str(reason), action=item.get('action', ''),
         csv=item.get('csv_path', ''), retryable=bool(item.get('date') and item.get('title')))

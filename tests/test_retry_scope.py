import importlib.util, os, unittest, subprocess, sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('progress_events',Path(__file__).parents[1]/'lms-bot'/'progress_events.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class RetryScope(unittest.TestCase):
    def test_empty_setting_from_gui(self):
        env={**os.environ, 'RETRY_SESSION':''}
        result=subprocess.run([sys.executable,'-c',"import sys;sys.path.insert(0,'lms-bot');import progress_events;assert progress_events.TARGET is None"],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
    def test_exact_session_only(self):
        p.START_DATE='2026-10-09';p.END_DATE='2026-10-11';p.TARGET={'date':'2026-10-10','title':'Session 2'}
        items=[{'date':'2026-10-10','title':'Session 1'},{'date':'2026-10-10','title':'Session 2'},{'date':'2026-10-11','title':'Session 2'}]
        self.assertEqual(p.select(items),[items[1]])
    def test_both_date_boundaries(self):
        p.TARGET=None;p.START_DATE='2026-10-09';p.END_DATE='2026-10-11'
        self.assertEqual([x['date'] for x in p.select([{'date':f'2026-10-{d:02}'} for d in range(8,13)])],['2026-10-09','2026-10-10','2026-10-11'])
if __name__=='__main__':unittest.main()

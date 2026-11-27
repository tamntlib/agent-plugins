import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('teams_session',pathlib.Path(__file__).with_name('teams_session.py'))
client=importlib.util.module_from_spec(SPEC) if SPEC else None
if SPEC and SPEC.loader and pathlib.Path(SPEC.origin).exists():
    SPEC.loader.exec_module(client)

class SessionTests(unittest.TestCase):
    def test_browser_bootstrap_uses_selected_provider_neutral_accessor(self):
        import contextlib,io
        context={'email':'reader@example.invalid','tenant':'11111111-1111-4111-8111-111111111111','account_type':'personal'}
        with tempfile.TemporaryDirectory() as tmp:
            accessor=pathlib.Path(tmp)/'approved_accessor.py'
            accessor.write_text("def evaluate(tab_id, expression):\n    assert tab_id == 'approved-tab'\n    assert 'localStorage' in expression\n    return "+repr({'ok':True,'context':context,'access_token':'synthetic-private-access','refresh_token':'synthetic-private-refresh'})+"\n")
            accessor.chmod(0o600)
            output=io.StringIO()
            original_env=dict(os.environ)
            with contextlib.redirect_stdout(output):
                result=client.browser_bundle(context,'approved-tab',str(accessor))
            self.assertEqual(result['context'],context)
            self.assertEqual(result['refresh_token'],'synthetic-private-refresh')
            self.assertIn('captured_at',result)
            self.assertEqual(output.getvalue(),'')
            self.assertEqual(dict(os.environ),original_env)

    def test_encrypted_store_survives_new_instance_without_plaintext(self):
        self.assertTrue(hasattr(client,'Store'),'encrypted store is not implemented')
        with tempfile.TemporaryDirectory() as tmp:
            context={'email':'reader@example.invalid','tenant':'11111111-1111-4111-8111-111111111111','account_type':'personal'}
            store=client.Store(pathlib.Path(tmp),'synthetic-profile',context)
            fixture={'context':context,'access_token':'synthetic-access-not-a-real-token','refresh_token':'synthetic-refresh-not-a-real-token'}
            with store.locked():store.save(fixture)
            self.assertEqual(client.Store(pathlib.Path(tmp),'synthetic-profile',context).load(),fixture)
            raw=store.path.read_bytes()
            self.assertNotIn(b'synthetic-refresh',raw)
            self.assertNotIn(b'synthetic-access',raw)
            self.assertEqual(store.path.stat().st_mode&0o777,0o600)
            self.assertEqual(store.key_path.stat().st_mode&0o777,0o600)
            self.assertNotEqual(store.key_path.parent,store.path.parent)

    def test_expired_access_refreshes_and_persists_rotation_without_browser(self):
        self.assertTrue(hasattr(client,'ensure_access'),'HTTP-first session flow is not implemented')
        import base64,time
        def access(exp):
            claims={'tid':'11111111-1111-4111-8111-111111111111','oid':'synthetic-user','aud':'https://ic3.teams.office.com','iss':'https://sts.windows.net/11111111-1111-4111-8111-111111111111/','idp':'live.com','exp':exp}
            return 'e30.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.synthetic'
        context={'email':'reader@example.invalid','tenant':'11111111-1111-4111-8111-111111111111','account_type':'personal'}
        class Response:
            status_code=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def iter_content(self,size):yield json.dumps({'access_token':access(time.time()+3600),'refresh_token':'synthetic-rotated','expires_in':3600}).encode()
        class Http:
            def __init__(self):self.calls=[]
            def request(self,method,url,**kw):self.calls.append((method,url,kw));return Response()
        with tempfile.TemporaryDirectory() as tmp:
            store=client.Store(pathlib.Path(tmp),'synthetic-profile',context)
            bundle={'context':context,'oid':'synthetic-user','access_token':access(time.time()-10),'refresh_token':'synthetic-old','client_id':'synthetic-client','origin':'https://teams.microsoft.com','base':'https://teams.microsoft.com/api/chatsvc/jp'}
            with store.locked():store.save(bundle)
            http=Http();result=client.ensure_access(store,http=http)
            self.assertTrue(result['refreshed'])
            self.assertEqual(store.load()['refresh_token'],'synthetic-rotated')
            self.assertEqual(len(http.calls),1)
            self.assertEqual(http.calls[0][2]['data']['grant_type'],'refresh_token')
            self.assertFalse(client.ensure_access(store,http=http)['refreshed'])
            self.assertEqual(len(http.calls),1)

    def test_thread_read_deduplicates_and_keeps_read_marker(self):
        self.assertTrue(hasattr(client,'read_thread'),'direct thread reader is not implemented')
        context={'tenant':'11111111-1111-4111-8111-111111111111'}
        conversation='19:synthetic@thread.tacv2';root='100';scoped=conversation+';messageid='+root
        link='https://internal.invalid/v1/users/ME/conversations/'+client.quote(scoped,safe='')+'/messages?syncState=synthetic'
        pages=[{'tenantId':context['tenant'],'messages':[{'id':'101','rootMessageId':root,'content':'<p>Reply</p>'}], '_metadata':{'backwardLink':link}}, {'tenantId':context['tenant'],'messages':[{'id':'100','rootMessageId':root,'content':'<p>Root</p>'},{'id':'101','rootMessageId':root,'content':'<p>Reply</p>'}], '_metadata':{}}]
        class Http:
            def request(self,method,url,**kwargs):
                self_outer.assertEqual(method,'GET');self_outer.assertTrue(url.startswith('https://teams.microsoft.com/api/chatsvc/jp/'))
                data=pages.pop(0) if '/messages' in url else {'properties':{'consumptionhorizon':'synthetic-marker'}}
                class R:
                    status_code=200
                    def __enter__(self):return self
                    def __exit__(self,*a):pass
                    def iter_content(self,size):yield json.dumps(data).encode()
                return R()
        self_outer=self
        result=client.read_thread({'context':context,'base':'https://teams.microsoft.com/api/chatsvc/jp','access_token':'synthetic'},conversation,root,http=Http(),page_size=1)
        self.assertEqual(result['uniqueMessages'],2)
        self.assertTrue(result['complete']);self.assertTrue(result['readMarkerUnchanged'])
        self.assertEqual(result['messages'][0]['text'],'Root')

    def test_bootstrap_commits_only_after_scoped_verification(self):
        self.assertTrue(hasattr(client,'bootstrap'),'encrypted bootstrap is not implemented')
        import base64,time
        context={'email':'reader@example.invalid','tenant':'11111111-1111-4111-8111-111111111111','account_type':'personal'}
        claims={'tid':context['tenant'],'oid':'synthetic-user','aud':'https://ic3.teams.office.com','iss':'https://sts.windows.net/'+context['tenant']+'/','idp':'live.com','exp':time.time()+3600}
        token='e30.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.synthetic'
        bundle={'context':context,'oid':'synthetic-user','access_token':token,'refresh_token':'synthetic-refresh','client_id':'synthetic-client'}
        with tempfile.TemporaryDirectory() as tmp:
            store=client.Store(pathlib.Path(tmp),'synthetic-profile',context)
            def denied(value):raise client.SessionError('target_access_denied')
            with self.assertRaises(client.SessionError):client.bootstrap(store,lambda:bundle,denied)
            self.assertFalse(store.path.exists())
            client.bootstrap(store,lambda:bundle,lambda b:{'ok':True})
            self.assertEqual(store.load()['refresh_token'],'synthetic-refresh')

    def test_cli_bootstrap_keeps_accessor_payload_private(self):
        import base64,contextlib,io,time
        from unittest import mock
        context={'email':'reader@example.invalid','tenant':'11111111-1111-4111-8111-111111111111','account_type':'personal'}
        claims={'tid':context['tenant'],'oid':'synthetic-user','aud':'https://ic3.teams.office.com','iss':'https://sts.windows.net/'+context['tenant']+'/','idp':'live.com','exp':time.time()+3600}
        token='e30.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.synthetic'
        bundle={'ok':True,'context':context,'oid':'synthetic-user','access_token':token,'refresh_token':'synthetic-private-refresh','client_id':'synthetic-client'}
        with tempfile.TemporaryDirectory() as tmp:
            accessor=pathlib.Path(tmp)/'approved_accessor.py'
            accessor.write_text("import sys\nprint('synthetic-private-module-output')\ndef evaluate(tab_id, expression):\n    print('synthetic-private-evaluator-output',file=sys.stderr)\n    return "+repr(bundle)+"\n")
            accessor.chmod(0o600)
            argv=['bootstrap','--store-dir',tmp,'--email',context['email'],'--tenant',context['tenant'],'--account-type','personal','--conversation','19:synthetic@thread.tacv2','--root','100','--tab-id','approved-tab','--browser-accessor',str(accessor)]
            output=io.StringIO();errors=io.StringIO()
            with mock.patch.dict(os.environ,{'TEAMS_CONTEXT':tmp}),mock.patch.object(client,'read_thread',return_value={'ok':True,'messages':[]}),contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
                code=client.main(argv)
            self.assertEqual(code,0)
            self.assertEqual(errors.getvalue(),'')
            result=json.loads(output.getvalue())
            self.assertTrue(result['browserUsed'])
            self.assertTrue(result['storedSession'])
            self.assertNotIn('synthetic-private',output.getvalue())
            store=client.Store(pathlib.Path(tmp),str(pathlib.Path(tmp).resolve()),context)
            self.assertEqual(store.load()['refresh_token'],'synthetic-private-refresh')

    def test_cli_status_missing_session_needs_no_browser(self):
        import subprocess,sys
        with tempfile.TemporaryDirectory() as tmp:
            command=[sys.executable,str(pathlib.Path(__file__).with_name('teams_session.py')),'status','--store-dir',tmp,'--email','reader@example.invalid','--tenant','11111111-1111-4111-8111-111111111111','--account-type','personal']
            env=dict(os.environ,TEAMS_CONTEXT=tmp)
            result=subprocess.run(command,capture_output=True,text=True,env=env,timeout=10)
            self.assertEqual(result.returncode,0)
            self.assertTrue(result.stdout.strip(),'CLI has not been implemented')
            self.assertFalse(json.loads(result.stdout)['storedSession'])
            self.assertFalse(list(pathlib.Path(tmp).rglob('*.key')))

    def test_standalone_status_uses_namespace_without_agent_home(self):
        import subprocess,sys
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)
            namespace=root/'tamntlib-skills'/'microsoft-teams'/'selected-context'
            store=root/'encrypted-store'
            command=[sys.executable,str(pathlib.Path(__file__).with_name('teams_session.py')),
                     'status','--store-dir',str(store),'--email','reader@example.invalid',
                     '--tenant','11111111-1111-4111-8111-111111111111','--account-type','personal']
            env={'HOME':tmp,'TMPDIR':tmp,'XDG_DATA_HOME':str(root/'data'),
                 'TEAMS_CONTEXT':str(namespace)}
            result=subprocess.run(command,capture_output=True,text=True,env=env,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout),{'ok':True,'storedSession':False,'browserUsed':False})
            self.assertFalse(namespace.exists())
            self.assertFalse(store.exists())

    def test_bootstrap_locks_capture_verification_and_commit(self):
        import base64,time,fcntl
        context={'email':'reader@example.invalid','tenant':'11111111-1111-4111-8111-111111111111','account_type':'personal'}
        claims={'tid':context['tenant'],'oid':'synthetic-user','aud':'https://ic3.teams.office.com','iss':'https://sts.windows.net/'+context['tenant']+'/','idp':'live.com','exp':time.time()+3600}
        token='e30.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.synthetic'
        bundle={'context':context,'oid':'synthetic-user','access_token':token,'refresh_token':'synthetic-refresh','client_id':'synthetic-client'}
        with tempfile.TemporaryDirectory() as tmp:
            store=client.Store(pathlib.Path(tmp),'synthetic-profile',context)
            with store.locked():store.save(bundle)
            def assert_locked():
                fd=os.open(store.lock_path,os.O_RDWR)
                try:
                    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    except BlockingIOError:return
                    self.fail('bootstrap did not hold the session lock')
                finally:os.close(fd)
            def capture():assert_locked();return bundle
            def verify(value):assert_locked();return {'ok':True}
            client.bootstrap(store,capture,verify)

    def test_key_initialization_never_publishes_unwritten_key(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            a={'email':'first@example.invalid'};b={'email':'second@example.invalid'}
            first=client.Store(pathlib.Path(tmp),'synthetic-profile',a)
            second=client.Store(pathlib.Path(tmp),'synthetic-profile',b)
            first.prepare();second.prepare()
            self.assertEqual(first.key_path,second.key_path)
            real_fdopen=os.fdopen;interleaved=[];peer_errors=[]
            def interleave(fd,*args,**kwargs):
                if not interleaved and args and args[0]=='wb':
                    interleaved.append(True)
                    try:second.cipher(create=True)
                    except client.SessionError as error:peer_errors.append(str(error))
                return real_fdopen(fd,*args,**kwargs)
            with mock.patch.object(client.os,'fdopen',side_effect=interleave):
                with first.locked():first.save({'context':a,'refresh_token':'synthetic-first'})
            self.assertTrue(interleaved)
            self.assertEqual(peer_errors,[],'second context observed an incomplete key')
            with second.locked():second.save({'context':b,'refresh_token':'synthetic-second'})
            self.assertEqual(first.load()['refresh_token'],'synthetic-first')
            self.assertEqual(second.load()['refresh_token'],'synthetic-second')

    def test_wrong_refresh_context_does_not_replace_ciphertext(self):
        import base64,time
        from unittest import mock
        context={'email':'reader@example.invalid','tenant':'11111111-1111-4111-8111-111111111111','account_type':'personal'}
        claims={'tid':context['tenant'],'oid':'synthetic-user','aud':'https://ic3.teams.office.com','iss':'https://sts.windows.net/'+context['tenant']+'/','idp':'live.com','exp':time.time()+3600}
        def encode(value):return 'e30.'+base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')+'.synthetic'
        bundle={'context':context,'oid':'synthetic-user','access_token':encode(claims),'refresh_token':'synthetic-refresh','client_id':'synthetic-client','origin':'https://teams.microsoft.com'}
        with tempfile.TemporaryDirectory() as tmp:
            store=client.Store(pathlib.Path(tmp),'synthetic-profile',context)
            with store.locked():store.save(bundle)
            original=store.path.read_bytes()
            for changed in [{'iss':'https://example.invalid/'},{'tid':'22222222-2222-4222-8222-222222222222'},{'aud':'https://graph.microsoft.com'},{'oid':'another-synthetic-user'},{'idp':'another-provider'},{'exp':time.time()-1}]:
                with self.subTest(changed_field=next(iter(changed))):
                    response={'access_token':encode(dict(claims,**changed)),'refresh_token':'synthetic-rotated'}
                    with mock.patch.object(client,'request_json',return_value=(200,response)):
                        with self.assertRaises(client.SessionError):client.ensure_access(store,force_refresh=True,http=object())
                    self.assertEqual(store.path.read_bytes(),original)
            with mock.patch.object(client,'request_json',return_value=(400,{'error':'invalid_grant','error_description':'synthetic-private-provider-description'})):
                with self.assertRaisesRegex(client.SessionError,'^reauthentication_required$'):client.ensure_access(store,force_refresh=True,http=object())
            self.assertEqual(store.path.read_bytes(),original)

    def test_corrupt_ciphertext_and_lost_key_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            context={'email':'reader@example.invalid'}
            store=client.Store(pathlib.Path(tmp),'synthetic-profile',context)
            with store.locked():store.save({'context':context,'refresh_token':'synthetic-refresh'})
            original=store.path.read_bytes()
            store.path.write_bytes(original[:-1]+bytes([original[-1]^1]))
            with self.assertRaisesRegex(client.SessionError,'^encrypted_store_invalid$'):store.load()
            store.path.write_bytes(original);store.key_path.unlink()
            with self.assertRaisesRegex(client.SessionError,'^encryption_key_missing$'):store.load()
            with self.assertRaisesRegex(client.SessionError,'^encryption_key_missing$'):
                with store.locked():store.save({'context':context})
            self.assertFalse(store.key_path.exists())
            self.assertEqual(store.path.read_bytes(),original)

    def test_ciphertext_cannot_be_rebound_to_another_account_or_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            a={'email':'first@example.invalid'};b={'email':'second@example.invalid'}
            first=client.Store(pathlib.Path(tmp),'synthetic-profile',a)
            with first.locked():first.save({'context':a,'refresh_token':'synthetic-refresh'})
            for profile,context,code in [('synthetic-profile',b,'stored_context_mismatch'),('another-profile',a,'encryption_key_missing')]:
                other=client.Store(pathlib.Path(tmp),profile,context);other.prepare()
                other.path.write_bytes(first.path.read_bytes());os.chmod(other.path,0o600)
                with self.assertRaisesRegex(client.SessionError,'^'+code+'$'):other.load()

    def test_read_retries_401_once_without_browser(self):
        import contextlib,io
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            argv=['read','--store-dir',tmp,'--email','reader@example.invalid','--tenant','11111111-1111-4111-8111-111111111111','--account-type','personal','--conversation','19:synthetic@thread.tacv2','--root','100']
            for repeated in [False,True]:
                with self.subTest(repeated_401=repeated):
                    outcomes=[client.SessionError('api_access_rejected'),client.SessionError('api_access_rejected') if repeated else {'ok':True,'messages':[]}]
                    states=[{'bundle':{},'refreshed':False},{'bundle':{},'refreshed':True}]
                    output=io.StringIO()
                    with mock.patch.dict(os.environ,{'TEAMS_CONTEXT':tmp}),mock.patch.object(client,'ensure_access',side_effect=states) as renewal,mock.patch.object(client,'read_thread',side_effect=outcomes) as read,contextlib.redirect_stdout(output):
                        code=client.main(argv)
                    self.assertEqual(renewal.call_count,2)
                    self.assertTrue(renewal.call_args.kwargs['force_refresh'])
                    self.assertEqual(read.call_count,2)
                    result=json.loads(output.getvalue())
                    self.assertEqual(code,2 if repeated else 0)
                    if repeated:self.assertEqual(result['error'],'api_access_rejected');self.assertFalse(result['reauthenticationRequired'])
                    else:self.assertFalse(result['browserUsed'])

    def test_explicit_neutral_context(self):
        import contextlib,io
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            context=str(pathlib.Path(tmp)/'selected-context')
            argv=['status','--store-dir',tmp,'--email','reader@example.invalid','--tenant','11111111-1111-4111-8111-111111111111','--account-type','personal']
            for env in [{'TEAMS_CONTEXT':context}]:
                output=io.StringIO()
                with self.subTest(env=env),mock.patch.dict(os.environ,env,clear=True),mock.patch.object(client,'Store',wraps=client.Store) as store,contextlib.redirect_stdout(output):
                    code=client.main(argv)
                self.assertEqual(code,0,output.getvalue())
                self.assertEqual(store.call_args.args[1],context)
                self.assertFalse(json.loads(output.getvalue())['browserUsed'])

    def test_empty_xdg_data_home_falls_back_to_home_not_cwd(self):
        import contextlib,io
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)
            home=root/'home';home.mkdir(mode=0o700)
            context=str(root/'selected-context')
            argv=['status','--email','reader@example.invalid','--tenant','11111111-1111-4111-8111-111111111111','--account-type','personal']
            output=io.StringIO()
            env={'HOME':str(home),'XDG_DATA_HOME':'','TEAMS_CONTEXT':context}
            with mock.patch.dict(os.environ,env,clear=True),mock.patch.object(client,'Store',wraps=client.Store) as store,contextlib.redirect_stdout(output):
                code=client.main(argv)
            self.assertEqual(code,0,output.getvalue())
            store_dir=store.call_args.args[0]
            self.assertTrue(store_dir.is_absolute())
            self.assertEqual(store_dir,home/'.local/share/microsoft-teams')
            self.assertNotEqual(store_dir.resolve(),(pathlib.Path.cwd()/'microsoft-teams').resolve())

    def test_plain_namespace_context_is_cwd_independent(self):
        import contextlib,io
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)
            dir_a=root/'dir-a';dir_b=root/'dir-b'
            dir_a.mkdir(mode=0o700);dir_b.mkdir(mode=0o700)
            argv=['status','--store-dir',str(root/'store'),'--email','reader@example.invalid','--tenant','11111111-1111-4111-8111-111111111111','--account-type','personal']
            seen=[]
            old_cwd=os.getcwd()
            try:
                for workdir in (dir_a,dir_b):
                    os.chdir(workdir)
                    output=io.StringIO()
                    with mock.patch.dict(os.environ,{'TEAMS_CONTEXT':'personal'},clear=True),mock.patch.object(client,'Store',wraps=client.Store) as store,contextlib.redirect_stdout(output):
                        code=client.main(argv)
                    self.assertEqual(code,0,output.getvalue())
                    seen.append(store.call_args.args[1])
            finally:
                os.chdir(old_cwd)
            self.assertEqual(seen,['personal','personal'])
            bad_out=io.StringIO()
            with mock.patch.dict(os.environ,{'TEAMS_CONTEXT':'invalid context'},clear=True),contextlib.redirect_stdout(bad_out):
                code=client.main(argv)
            self.assertEqual(code,2)
            self.assertEqual(json.loads(bad_out.getvalue())['error'],'invalid_teams_context')

    def test_thread_read_accepts_alphanumeric_and_hyphenated_regions(self):
        context={'tenant':'11111111-1111-4111-8111-111111111111'}
        conversation='19:synthetic@thread.tacv2';root='100'
        for base in ('https://teams.microsoft.com/api/chatsvc/emea2','https://teams.cloud.microsoft/api/chatsvc/apac-01/'):
            with self.subTest(base=base):
                class Http:
                    def request(self,method,url,**kwargs):
                        data={'tenantId':context['tenant'],'messages':[{'id':root,'rootMessageId':root,'content':'<p>Hi</p>'}],'_metadata':{}} if '/messages' in url else {'properties':{'consumptionhorizon':'m'}}
                        class R:
                            status_code=200
                            def __enter__(self):return self
                            def __exit__(self,*a):pass
                            def iter_content(self,size):yield json.dumps(data).encode()
                        return R()
                result=client.read_thread({'context':context,'base':base,'access_token':'synthetic'},conversation,root,http=Http())
                self.assertEqual(result['uniqueMessages'],1)
        for bad_base in ('https://teams.microsoft.com/api/chatsvc/../evil','https://teams.microsoft.com/api/chatsvc/jp/extra','https://teams.microsoft.com/api/chatsvc/EMEA'):
            with self.subTest(bad_base=bad_base):
                with self.assertRaisesRegex(client.SessionError,'^unsafe_service_base$'):
                    client.read_thread({'context':context,'base':bad_base,'access_token':'synthetic'},conversation,root,http=object())

if __name__=='__main__':unittest.main()

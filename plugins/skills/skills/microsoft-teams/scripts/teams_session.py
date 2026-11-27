"""Teams user session: encrypted persistence, HTTP renewal, browser reauthentication only.

Secret values are deliberately excluded from exceptions and command output.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
from urllib.parse import quote, unquote, urlsplit
from cryptography.fernet import Fernet, InvalidToken

class SessionError(Exception):
    pass


def private_dir(path):
    path=Path(path)
    if path.is_symlink():raise SessionError('unsafe_directory')
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    info=path.stat()
    if info.st_uid!=os.getuid() or info.st_mode&0o077:raise SessionError('unsafe_directory_permissions')


def private_read(path,limit=1024*1024):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        info=os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise SessionError('unsafe_file_permissions')
        data=f.read(limit+1)
        if len(data)>limit:raise SessionError('file_too_large')
        return data


class Store:
    def __init__(self,root,profile,context):
        self.root=Path(root)
        self.context=context
        profile_id=hashlib.sha256(str(profile).encode()).hexdigest()[:16]
        context_id=hashlib.sha256(json.dumps(context,sort_keys=True).encode()).hexdigest()[:24]
        self.key_path=self.root/'keys'/(profile_id+'.key')
        self.path=self.root/'sessions'/profile_id/(context_id+'.enc')
        self.lock_path=self.path.with_suffix('.lock')

    def prepare(self):
        for p in [self.root,self.root/'keys',self.root/'sessions',self.path.parent]:private_dir(p)

    @contextlib.contextmanager
    def locked(self):
        self.prepare()
        fd=os.open(self.lock_path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(fd)
            if info.st_uid!=os.getuid() or info.st_mode&0o077 or not stat.S_ISREG(info.st_mode):raise SessionError('unsafe_lock')
            fcntl.flock(fd,fcntl.LOCK_EX)
            yield self
        finally:os.close(fd)

    def cipher(self,create=False):
        if not self.key_path.exists():
            if not create or self.path.exists():raise SessionError('encryption_key_missing')
            key=Fernet.generate_key()
            # Publish a complete, fsynced key without replacing a concurrent
            # creator. Context locks differ, but the profile key is shared.
            fd,pending=tempfile.mkstemp(prefix='.key-pending-',dir=self.key_path.parent)
            try:
                with os.fdopen(fd,'wb') as f:f.write(key);f.flush();os.fsync(f.fileno())
                try:os.link(pending,self.key_path)
                except FileExistsError:pass
                directory=os.open(self.key_path.parent,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(directory)
                finally:os.close(directory)
            finally:
                if os.path.exists(pending):os.unlink(pending)
        try:return Fernet(private_read(self.key_path,100))
        except (ValueError,InvalidToken):raise SessionError('encryption_key_invalid') from None

    def load(self):
        if not self.path.exists():return None
        try:bundle=json.loads(self.cipher().decrypt(private_read(self.path)))
        except (InvalidToken,ValueError):raise SessionError('encrypted_store_invalid') from None
        if bundle.get('context')!=self.context:raise SessionError('stored_context_mismatch')
        return bundle

    def save(self,bundle):
        if bundle.get('context')!=self.context:raise SessionError('stored_context_mismatch')
        self.prepare()
        encrypted=self.cipher(create=True).encrypt(json.dumps(bundle,ensure_ascii=False).encode())
        if self.path.is_symlink():raise SessionError('unsafe_store_target')
        if self.path.exists():private_read(self.path)
        fd,tmp=tempfile.mkstemp(prefix='.pending-',dir=self.path.parent)
        try:
            with os.fdopen(fd,'wb') as f:f.write(encrypted);f.flush();os.fsync(f.fileno())
            os.replace(tmp,self.path)
            directory=os.open(self.path.parent,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(directory)
            finally:os.close(directory)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)


def token_claims(token):
    try:
        encoded=token.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4)))
    except Exception:raise SessionError('invalid_access_token') from None


def validate_bundle(bundle,require_fresh=False):
    context=bundle['context'];p=token_claims(bundle['access_token']);tenant=context['tenant']
    if p.get('aud')!='https://ic3.teams.office.com' or p.get('tid')!=tenant or p.get('oid')!=bundle.get('oid') or not p.get('oid'):raise SessionError('token_context_mismatch')
    if p.get('iss') not in {'https://sts.windows.net/'+tenant+'/','https://login.microsoftonline.com/'+tenant+'/v2.0'}:raise SessionError('token_issuer_mismatch')
    if context['account_type']=='personal' and p.get('idp')!='live.com':raise SessionError('token_identity_mismatch')
    if not isinstance(p.get('exp'),(int,float)):raise SessionError('token_expiry_missing')
    if require_fresh and p['exp']<=time.time()+60:raise SessionError('renewed_token_expired')
    return p


def request_json(http,method,url,**kwargs):
    try:
        with http.request(method,url,allow_redirects=False,timeout=(10,30),stream=True,**kwargs) as r:
            data=bytearray()
            for chunk in r.iter_content(65536):
                data.extend(chunk)
                if len(data)>4*1024*1024:raise SessionError('response_too_large')
            try:body=json.loads(data)
            except Exception:raise SessionError('invalid_response_json') from None
            return r.status_code,body
    except SessionError:raise
    except Exception:raise SessionError('http_transport_failed') from None


def refresh_bundle(bundle,http):
    validate_bundle(bundle)
    if not bundle.get('refresh_token'):raise SessionError('reauthentication_required')
    origin=bundle.get('origin')
    if origin not in {'https://teams.microsoft.com','https://teams.cloud.microsoft'}:raise SessionError('invalid_teams_origin')
    tenant=bundle['context']['tenant']
    if not re.fullmatch(r'[0-9a-fA-F-]{36}',tenant):raise SessionError('invalid_tenant')
    status,data=request_json(http,'POST','https://login.microsoftonline.com/'+tenant+'/oauth2/v2.0/token',headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin},data={'grant_type':'refresh_token','client_id':bundle['client_id'],'refresh_token':bundle['refresh_token'],'scope':'https://ic3.teams.office.com/.default offline_access'})
    if status!=200:
        error=data.get('error') if isinstance(data,dict) else None
        if error in {'invalid_grant','interaction_required','login_required'}:raise SessionError('reauthentication_required')
        if error in {'invalid_scope','consent_required','invalid_client','unauthorized_client'}:raise SessionError('refresh_configuration_or_consent_refused')
        raise SessionError('http_refresh_failed')
    if not isinstance(data.get('access_token'),str):raise SessionError('refresh_response_incomplete')
    updated=dict(bundle,access_token=data['access_token'])
    if data.get('refresh_token'):
        if not isinstance(data['refresh_token'],str):raise SessionError('refresh_response_incomplete')
        updated['refresh_token']=data['refresh_token']
    validate_bundle(updated,require_fresh=True)
    updated['last_refreshed_at']=time.time()
    return updated


def ensure_access(store,force_refresh=False,http=None):
    with store.locked():
        bundle=store.load()
        if bundle is None:raise SessionError('reauthentication_required')
        claims=validate_bundle(bundle)
        refresh=force_refresh or claims['exp']<=time.time()+120
        if refresh:
            if http is None:
                import requests
                with requests.Session() as session:
                    session.trust_env=False
                    bundle=refresh_bundle(bundle,session)
            else:bundle=refresh_bundle(bundle,http)
            store.save(bundle)
        return {'bundle':bundle,'refreshed':refresh}


def read_thread(bundle,conversation,root,http,page_size=50,max_pages=20):
    if not re.fullmatch(r'19:[^\s/]+@thread\.(?:tacv2|v2)',conversation) or not re.fullmatch(r'\d+',root):raise SessionError('invalid_thread_target')
    if not 1<=page_size<=200 or not 1<=max_pages<=100:raise SessionError('invalid_page_limits')
    base=bundle['base'];u=urlsplit(base)
    if u.scheme!='https' or u.hostname not in {'teams.microsoft.com','teams.cloud.microsoft'} or u.port or u.username or u.password or u.query or u.fragment or not re.fullmatch(r'/api/chatsvc/[a-z0-9-]+/?',u.path):raise SessionError('unsafe_service_base')
    prefix=base.rstrip('/')+'/v1/users/ME/conversations/'
    scoped=conversation+';messageid='+root
    endpoint=prefix+quote(scoped,safe='')+'/messages'
    metadata=prefix+quote(conversation,safe='')
    statuses=[]
    def get(url):
        status,data=request_json(http,'GET',url,headers={'Authorization':'Bearer '+bundle['access_token'],'Accept':'application/json','behavioroverride':'redirectAs404'})
        statuses.append(status)
        if status==401:raise SessionError('api_access_rejected')
        if status==403:raise SessionError('target_access_denied')
        if status!=200:raise SessionError('api_read_failed')
        return data
    before=get(metadata)
    messages={};seen=set();pages=0;next_page=endpoint+'?pageSize='+str(page_size)
    from html.parser import HTMLParser
    class Text(HTMLParser):
        def __init__(self):super().__init__(convert_charrefs=True);self.parts=[]
        def handle_data(self,value):self.parts.append(value)
    while next_page and pages<max_pages:
        if next_page in seen:raise SessionError('repeated_continuation')
        seen.add(next_page);data=get(next_page);pages+=1
        if data.get('tenantId')!=bundle['context']['tenant'] or not isinstance(data.get('messages'),list):raise SessionError('response_context_mismatch')
        for message in data['messages']:
            mid=message.get('id')
            if not isinstance(mid,str) or (mid!=root and message.get('rootMessageId')!=root):raise SessionError('out_of_scope_message')
            props=message.get('properties',{})
            if props.get('deletetime'):continue
            content=message.get('content') or '';parser=Text();parser.feed(content)
            messages[mid]={'id':mid,'rootMessageId':message.get('rootMessageId') or root,'sender':message.get('imdisplayname'),'subject':props.get('subject'),'time':message.get('originalarrivaltime'),'text':''.join(parser.parts),'contentSha256':hashlib.sha256(content.encode()).hexdigest()}
        link=data.get('_metadata',{}).get('backwardLink')
        if not link:next_page=None;break
        follow=urlsplit(link);match=re.search(r'/v1/users/[^/]+/conversations/([^/]+)/messages$',follow.path)
        if follow.scheme!='https' or follow.username or follow.password or follow.fragment or not match or unquote(match.group(1))!=scoped:raise SessionError('unsafe_continuation')
        next_page=endpoint+('?' + follow.query if follow.query else '')
    after=get(metadata)
    h1=before.get('properties',{}).get('consumptionhorizon');h2=after.get('properties',{}).get('consumptionhorizon')
    observed=isinstance(h1,str) and isinstance(h2,str)
    return {'ok':True,'transport':'direct_https','httpStatuses':statuses,'pages':pages,'complete':next_page is None,'uniqueMessages':len(messages),'rootPresent':root in messages,'readMarkerObserved':observed,'readMarkerUnchanged':h1==h2 if observed else None,'messages':sorted(messages.values(),key=lambda m:int(m['id']))}


def bootstrap(store,accessor,verify):
    # Capture, verify and commit share the same lock as HTTP refresh, so an
    # in-flight refresh cannot be overwritten by a browser snapshot.
    with store.locked():
        candidate=accessor()
        if candidate.get('context')!=store.context or not candidate.get('refresh_token') or not candidate.get('client_id'):raise SessionError('browser_context_incomplete')
        validate_bundle(candidate,require_fresh=True)
        result=verify(candidate)
        if result.get('ok') is not True:raise SessionError('bootstrap_verification_failed')
        store.save(candidate)
    return result


def browser_bundle(context,tab_id,accessor_path=None):
    # Explicit bootstrap only: the trusted accessor owns native browser routing.
    if not accessor_path:raise SessionError('approved_browser_accessor_required')
    accessor_path=Path(accessor_path)
    if not accessor_path.is_absolute():raise SessionError('invalid_browser_accessor')
    import importlib.util
    import io
    try:
        private_read(accessor_path)
        spec=importlib.util.spec_from_file_location('_teams_browser_accessor',accessor_path)
        if spec is None or spec.loader is None:raise SessionError('invalid_browser_accessor')
        accessor=importlib.util.module_from_spec(spec)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            spec.loader.exec_module(accessor)
        evaluate=getattr(accessor,'evaluate',None)
        if not callable(evaluate):raise SessionError('invalid_browser_accessor')
    except SessionError:raise
    except Exception:raise SessionError('browser_access_failed') from None
    expression='''(() => {const cfg=CONTEXT;if(!['https://teams.microsoft.com','https://teams.cloud.microsoft'].includes(location.origin))return {ok:false};let access=null,claims=null;const bases=new Set();for(let i=0;i<localStorage.length;i++){const name=localStorage.key(i);try{const entry=JSON.parse(localStorage.getItem(name));if(name.includes('DISCOVER-REGION-GTM')&&typeof entry.item?.chatServiceAfd==='string')bases.add(entry.item.chatServiceAfd);if(entry?.credentialType!=='AccessToken'||typeof entry.secret!=='string')continue;const s=entry.secret.split('.')[1],p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(s.length/4)*4,'=')),x=>x.charCodeAt(0))));if(p.tid===cfg.tenant&&p.aud==='https://ic3.teams.office.com'&&[p.preferred_username,p.upn,p.email].some(x=>typeof x==='string'&&x.toLowerCase()===cfg.email.toLowerCase())&&(cfg.account_type!=='personal'||p.idp==='live.com')&&(!claims||p.exp>claims.exp)){access=entry;claims=p;}}catch{}}if(!access?.homeAccountId||!access.clientId||bases.size!==1)return {ok:false};let refresh=null;for(let i=0;i<localStorage.length;i++){try{const entry=JSON.parse(localStorage.getItem(localStorage.key(i)));if(entry?.credentialType==='RefreshToken'&&entry.homeAccountId===access.homeAccountId&&entry.clientId===access.clientId&&entry.environment===access.environment&&typeof entry.secret==='string'&&entry.secret.length>0){if(refresh&&refresh.secret!==entry.secret)return {ok:false};refresh=entry;}}catch{}}if(!refresh)return {ok:false};return {ok:true,context:cfg,oid:claims.oid,access_token:access.secret,refresh_token:refresh.secret,client_id:access.clientId,home_account_id:access.homeAccountId,environment:access.environment,origin:location.origin,base:[...bases][0]};})()'''.replace('CONTEXT',json.dumps(context))
    try:
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            result=evaluate(tab_id,expression)
        if isinstance(result,str):result=json.loads(result)
    except Exception:raise SessionError('browser_access_failed') from None
    if not isinstance(result,dict) or result.pop('ok',False) is not True:raise SessionError('browser_context_incomplete')
    result['captured_at']=time.time()
    return result


def normalize_context(profile):
    if not isinstance(profile,str) or not profile:raise SessionError('teams_context_missing')
    if profile in {'.','..'} or profile.startswith(('~','./','../')) or '/' in profile or '\\' in profile or os.path.isabs(profile):
        return str(Path(profile).expanduser().resolve())
    if re.fullmatch(r'[A-Za-z0-9._-]+',profile):
        return profile
    raise SessionError('invalid_teams_context')


def main(argv=None):
    parser=argparse.ArgumentParser(description='Encrypted Teams session; direct HTTP by default, explicit browser bootstrap only.')
    parser.add_argument('command',choices=['status','bootstrap','refresh','read'])
    parser.add_argument('--email',required=True)
    parser.add_argument('--tenant',required=True)
    parser.add_argument('--account-type',choices=['personal','work'],required=True)
    parser.add_argument('--store-dir',type=Path,default=Path(os.environ.get('XDG_DATA_HOME') or str(Path.home()/'.local/share'))/'microsoft-teams')
    parser.add_argument('--conversation');parser.add_argument('--root')
    parser.add_argument('--tab-id');parser.add_argument('--browser-accessor',help='Approved private Python accessor file exposing evaluate(tab_id, expression).')
    parser.add_argument('--page-size',type=int,default=50)
    parser.add_argument('--max-pages',type=int,default=20)
    parser.add_argument('--summary',action='store_true')
    args=parser.parse_args(argv)
    try:
        profile=normalize_context(os.environ.get('TEAMS_CONTEXT'))
        if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}',args.tenant):raise SessionError('invalid_tenant')
        if not args.email or '@' not in args.email:raise SessionError('invalid_account')
        context={'email':args.email,'tenant':args.tenant,'account_type':args.account_type}
        store=Store(args.store_dir,profile,context)
        if args.command=='status':
            bundle=store.load()
            if bundle is None:result={'ok':True,'storedSession':False,'browserUsed':False}
            else:
                claims=validate_bundle(bundle)
                result={'ok':True,'storedSession':True,'accessTokenFresh':claims['exp']>time.time()+120,'refreshTokenPresent':bool(bundle.get('refresh_token')),'browserUsed':False}
        else:
            import requests
            with requests.Session() as http:
                http.trust_env=False
                if args.command=='refresh':
                    session=ensure_access(store,force_refresh=True,http=http)
                    result={'ok':True,'httpRefreshed':session['refreshed'],'browserUsed':False,'storedSession':True}
                else:
                    if not args.conversation or not args.root:raise SessionError('thread_target_required')
                    def verify(bundle):return read_thread(bundle,args.conversation,args.root,http,args.page_size,args.max_pages)
                    if args.command=='bootstrap':
                        if not args.tab_id:raise SessionError('approved_browser_tab_required')
                        result=bootstrap(store,lambda:browser_bundle(context,args.tab_id,args.browser_accessor),verify)
                        result.update(browserUsed=True,storedSession=True,httpRefreshed=False)
                    else:
                        session=ensure_access(store,http=http)
                        try:result=verify(session['bundle'])
                        except SessionError as error:
                            if str(error)!='api_access_rejected' or session['refreshed']:raise
                            session=ensure_access(store,force_refresh=True,http=http)
                            result=verify(session['bundle'])
                        result.update(browserUsed=False,storedSession=True,httpRefreshed=session['refreshed'])
                    if args.summary:
                        for message in result.get('messages',[]):message.pop('text',None)
        print(json.dumps(result,ensure_ascii=False))
        return 0
    except SessionError as error:
        # All SessionError messages are fixed code literals, never provider text.
        print(json.dumps({'ok':False,'error':str(error),'reauthenticationRequired':str(error)=='reauthentication_required'}))
        return 2
    except Exception:
        print(json.dumps({'ok':False,'error':'operation_failed'}))
        return 1


if __name__=='__main__':
    sys.exit(main())

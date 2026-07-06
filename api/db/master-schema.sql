CREATE TABLE public.agent_releases (
    id integer NOT NULL,
    version character varying(255) NOT NULL,
    filename character varying(255) NOT NULL,
    sha256 character varying(255),
    notes text,
    mandatory boolean DEFAULT false NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    size_bytes bigint,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.agent_releases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.agent_releases_id_seq OWNED BY public.agent_releases.id;

CREATE TABLE public.app_releases (
    id integer NOT NULL,
    version character varying(255) NOT NULL,
    version_code integer DEFAULT 0 NOT NULL,
    filename character varying(255) NOT NULL,
    sha256 character varying(255),
    notes text,
    mandatory boolean DEFAULT false NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    size_bytes bigint,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.app_releases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.app_releases_id_seq OWNED BY public.app_releases.id;

CREATE TABLE public.license_permissions (
    id bigint NOT NULL,
    license_id bigint NOT NULL,
    permission_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.license_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.license_permissions_id_seq OWNED BY public.license_permissions.id;

CREATE TABLE public.licenses (
    id bigint NOT NULL,
    license_key_hash character varying(128) NOT NULL,
    key_prefix character varying(40) NOT NULL,
    tally_serial character varying(60),
    holder_name character varying(191) NOT NULL,
    plan character varying(40) DEFAULT 'standard'::character varying NOT NULL,
    max_companies integer DEFAULT 5 NOT NULL,
    max_users integer DEFAULT 10 NOT NULL,
    valid_until date,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    machine_id character varying(191),
    machine_bound_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    agent_version character varying(40),
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    last_open_companies text,
    auto_update boolean DEFAULT true NOT NULL,
    sync_push_enabled boolean DEFAULT true NOT NULL,
    sync_pull_enabled boolean DEFAULT true NOT NULL,
    license_key_enc text,
    sync_enabled boolean DEFAULT true NOT NULL,
    sync_push_modules text,
    sync_pull_modules text
);

CREATE SEQUENCE public.licenses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.licenses_id_seq OWNED BY public.licenses.id;

CREATE TABLE public.password_resets (
    id bigint NOT NULL,
    email character varying(191) NOT NULL,
    token character varying(191) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.password_resets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.password_resets_id_seq OWNED BY public.password_resets.id;

CREATE TABLE public.permissions (
    id bigint NOT NULL,
    module character varying(60) NOT NULL,
    action character varying(20) NOT NULL,
    slug character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.permissions_id_seq OWNED BY public.permissions.id;

CREATE TABLE public.sessions (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);

CREATE TABLE public.subscriptions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    plan character varying(40) DEFAULT 'standard'::character varying NOT NULL,
    valid_from date NOT NULL,
    valid_until date NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;

CREATE TABLE public.system_settings (
    id integer NOT NULL,
    key character varying(120) NOT NULL,
    value jsonb,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.system_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.system_settings_id_seq OWNED BY public.system_settings.id;

CREATE TABLE public.user_sessions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    jti character varying(64) NOT NULL,
    platform character varying(16),
    ip character varying(64),
    user_agent character varying(255),
    last_seen_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.user_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_sessions_id_seq OWNED BY public.user_sessions.id;

CREATE TABLE public.users (
    id bigint NOT NULL,
    company_id bigint,
    role_id bigint NOT NULL,
    location_id bigint,
    name character varying(150) NOT NULL,
    email character varying(191) NOT NULL,
    mobile character varying(30),
    password_hash character varying(255) NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    license_id bigint,
    current_company_id bigint,
    active_session_jti character varying(64),
    session_last_seen timestamp with time zone,
    session_expires_at timestamp with time zone,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approved_at timestamp with time zone,
    approved_by bigint
);

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

ALTER TABLE ONLY public.agent_releases ALTER COLUMN id SET DEFAULT nextval('public.agent_releases_id_seq'::regclass);

ALTER TABLE ONLY public.app_releases ALTER COLUMN id SET DEFAULT nextval('public.app_releases_id_seq'::regclass);

ALTER TABLE ONLY public.license_permissions ALTER COLUMN id SET DEFAULT nextval('public.license_permissions_id_seq'::regclass);

ALTER TABLE ONLY public.licenses ALTER COLUMN id SET DEFAULT nextval('public.licenses_id_seq'::regclass);

ALTER TABLE ONLY public.password_resets ALTER COLUMN id SET DEFAULT nextval('public.password_resets_id_seq'::regclass);

ALTER TABLE ONLY public.permissions ALTER COLUMN id SET DEFAULT nextval('public.permissions_id_seq'::regclass);

ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);

ALTER TABLE ONLY public.system_settings ALTER COLUMN id SET DEFAULT nextval('public.system_settings_id_seq'::regclass);

ALTER TABLE ONLY public.user_sessions ALTER COLUMN id SET DEFAULT nextval('public.user_sessions_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.agent_releases
    ADD CONSTRAINT agent_releases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_releases
    ADD CONSTRAINT app_releases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT license_permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_key_prefix_unique UNIQUE (key_prefix);

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_slug_unique UNIQUE (slug);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_key_unique UNIQUE (key);

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT uq_license_permissions UNIQUE (license_id, permission_id);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT uq_permissions_module_action UNIQUE (module, action);

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_jti_unique UNIQUE (jti);

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX "IDX_session_expire" ON public.sessions USING btree (expire);

CREATE INDEX agent_releases_is_current_index ON public.agent_releases USING btree (is_current);

CREATE INDEX app_releases_is_current_index ON public.app_releases USING btree (is_current);

CREATE INDEX idx_license_permissions_license ON public.license_permissions USING btree (license_id);

CREATE INDEX idx_licenses_status ON public.licenses USING btree (status);

CREATE INDEX idx_password_resets_email ON public.password_resets USING btree (email);

CREATE INDEX idx_password_resets_token ON public.password_resets USING btree (token);

CREATE INDEX idx_permissions_module ON public.permissions USING btree (module);

CREATE INDEX idx_subscriptions_user_status ON public.subscriptions USING btree (user_id, status);

CREATE INDEX idx_user_sessions_user ON public.user_sessions USING btree (user_id);

CREATE INDEX idx_users_approval_status ON public.users USING btree (approval_status);

CREATE INDEX idx_users_company_id ON public.users USING btree (company_id);

CREATE INDEX idx_users_email ON public.users USING btree (email);

CREATE INDEX idx_users_license ON public.users USING btree (license_id);

CREATE INDEX idx_users_role_id ON public.users USING btree (role_id);

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT license_permissions_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT license_permissions_permission_id_foreign FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_approved_by_foreign FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE SET NULL;

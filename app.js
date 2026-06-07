const SUPABASE_URL = 'https://oaapgalsprualadbfltv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hYXBnYWxzcHJ1YWxhZGJmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTQ0ODAsImV4cCI6MjA5NjMzMDQ4MH0.JP50HnTaKMg8gv38_tu81gcbTvGEhb6qY1pVzDq5XtE';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentCar = null;
let currentCarMembers = [];
let calculatedOdometer = 0; 

async function login() { await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }); }
async function logout() { await supabaseClient.auth.signOut(); showScreen('login-screen'); }

function showScreen(screenId) {
    ['login-screen', 'cars-screen', 'app-screen'].forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
}

function switchView(viewName, navElement) {
    document.querySelectorAll('.app-view').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + viewName).classList.remove('hidden');
    if(navElement) navElement.classList.add('active');
    
    if(viewName === 'dashboard') loadDashboardData();
    if(viewName === 'trip') prepareTripForm();
    if(viewName === 'refuel') prepareRefuelForm();
}

async function initializeApp(user) {
    currentUser = user;
    try {
        const { data: existingProfile } = await supabaseClient.from('profiles').select('*').eq('id', user.id).maybeSingle();
        if (!existingProfile) {
            await supabaseClient.from('profiles').insert({ id: user.id, display_name: user.user_metadata.full_name, email: user.email });
            document.getElementById('user-display-name').innerText = user.user_metadata.full_name || 'ללא שם';
        } else {
            document.getElementById('user-display-name').innerText = existingProfile.display_name || 'ללא שם';
        }
        document.getElementById('user-email-display').innerText = user.email;
    } catch(e) { console.warn("שגיאת פרופיל", e); }
    
    await loadUserCars(true);
}

async function editDisplayName() {
    const currentName = document.getElementById('user-display-name').innerText;
    const newName = prompt("הכנס כינוי חדש:", currentName);
    if (newName && newName.trim() !== "") {
        await supabaseClient.from('profiles').update({ display_name: newName.trim() }).eq('id', currentUser.id);
        document.getElementById('user-display-name').innerText = newName.trim();
    }
}

async function loadUserCars(isInitialLogin = false) {
    const listDiv = document.getElementById('my-cars-list');
    listDiv.innerHTML = 'טוען רכבים...';

    try {
        const { data: invites } = await supabaseClient.from('invitations').select('*').eq('invited_email', currentUser.email.toLowerCase());
        if (invites && invites.length > 0) {
            for (let inv of invites) {
                await supabaseClient.from('group_members').upsert({ group_id: inv.group_id, user_id: currentUser.id });
                await supabaseClient.from('invitations').delete().eq('id', inv.id);
            }
        }
    } catch(e) {}

    const { data: members, error } = await supabaseClient.from('group_members').select(`group_id, car_groups (id, name, initial_odo)`).eq('user_id', currentUser.id);
    if (error) {
        listDiv.innerHTML = 'שגיאה: ' + error.message; 
        showScreen('cars-screen');
        return;
    }
    
    const validMembers = members.filter(m => m.car_groups);

    // מעקף חכם: אם המשתמש נכנס כעת ויש לו בדיוק רכב אחד - העבר אותו ישירות אליו
    if (isInitialLogin && validMembers.length === 1 && !currentCar) {
        enterCar(validMembers[0].car_groups);
        return;
    }

    if (validMembers.length === 0) {
        listDiv.innerHTML = '<p>אין לך רכבים. צרי רכב חדש או בקשי הזמנה.</p>';
    } else {
        listDiv.innerHTML = '';
        validMembers.forEach(member => {
            const div = document.createElement('div');
            div.className = 'car-list-item';
            
            const infoDiv = document.createElement('div');
            infoDiv.style.flex = "1";
            infoDiv.innerHTML = `<strong>${member.car_groups.name || 'רכב ללא שם'}</strong>`;
            infoDiv.onclick = () => enterCar(member.car_groups);
            
            const btnDiv = document.createElement('div');
            const delBtn = document.createElement('button');
            delBtn.className = 'danger';
            delBtn.style.cssText = 'width: auto; padding: 5px 10px; margin: 0; font-size: 0.8rem;';
            delBtn.innerText = 'מחק רכב';
            delBtn.onclick = (e) => { e.stopPropagation(); leaveCar(member.group_id); };
            btnDiv.appendChild(delBtn);
            
            div.appendChild(infoDiv);
            div.appendChild(btnDiv);
            listDiv.appendChild(div);
        });
    }
    
    showScreen('cars-screen');
}

async function leaveCar(groupId) {
    if(confirm("למחוק את הרכב הזה מהרשימה שלך?")) {
        await supabaseClient.from('group_members').delete().match({ group_id: groupId, user_id: currentUser.id });
        loadUserCars();
    }
}

function showCreateCarForm() { document.getElementById('create-car-form').classList.remove('hidden'); }
function hideCreateCarForm() { document.getElementById('create-car-form').classList.add('hidden'); }

async function createCar() {
    const name = document.getElementById('new-car-name').value;
    const initialOdo = document.getElementById('new-car-odo').value;
    if (!name || !initialOdo) return alert("חסרים פרטים");
    
    const { data: newCar } = await supabaseClient.from('car_groups').insert({ name: name, initial_odo: parseFloat(initialOdo) }).select().single();
    await supabaseClient.from('group_members').insert({ group_id: newCar.id, user_id: currentUser.id });
    hideCreateCarForm();
    loadUserCars();
}

function enterCar(carObj) {
    currentCar = carObj;
    document.getElementById('active-car-name').innerText = carObj.name || 'רכב';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
    showScreen('app-screen');
}

function backToCars() {
    currentCar = null;
    currentCarMembers = [];
    document.getElementById('whatsapp-share-container').classList.add('hidden');
    loadUserCars();
}

function prepareTripForm() {
    document.getElementById('current-odo-hint').innerText = `מד אוץ קודם: ${calculatedOdometer.toFixed(0)}`;
    
    const participantsDiv = document.getElementById('trip-participants-list');
    participantsDiv.innerHTML = '';
    
    currentCarMembers.forEach(m => {
        const isMe = m.profiles.id === currentUser.id;
        participantsDiv.innerHTML += `
            <div class="checkbox-item">
                <input type="checkbox" id="part-${m.profiles.id}" value="${m.profiles.id}" ${isMe ? 'checked' : ''}>
                <label for="part-${m.profiles.id}" style="margin:0; font-weight:normal;">${isMe ? 'אני' : m.profiles.display_name}</label>
            </div>
        `;
    });
}

async function prepareRefuelForm() {
    document.getElementById('refuel-odo-hint').innerText = `מד אוץ משוער נוכחי: ${calculatedOdometer.toFixed(0)}`;
    
    // שליפת מד אוץ של תדלוק קודם בצורה דינמית ומאובטחת
    const { data: lastRefuels } = await supabaseClient.from('refuels').select('odometer').eq('group_id', currentCar.id).order('created_at', { ascending: false }).limit(1);
    if (lastRefuels && lastRefuels.length > 0) {
        document.getElementById('prev-refuel-odo-display').innerText = `מד אוץ בתדלוק הקודם: ${Number(lastRefuels[0].odometer).toFixed(0)}`;
    } else {
        document.getElementById('prev-refuel-odo-display').innerText = `מד אוץ בתדלוק הקודם: אין (משתמש במד אוץ התחלתי: ${Number(currentCar.initial_odo).toFixed(0)})`;
    }
    
    const refuelPartsDiv = document.getElementById('refuel-participants-list');
    refuelPartsDiv.innerHTML = '';
    
    currentCarMembers.forEach(m => {
        const isMe = m.profiles.id === currentUser.id;
        refuelPartsDiv.innerHTML += `
            <div class="checkbox-item">
                <input type="checkbox" id="refuel-part-${m.profiles.id}" value="${m.profiles.id}" ${isMe ? 'checked' : ''}>
                <label for="refuel-part-${m.profiles.id}" style="margin:0; font-weight:normal;">${isMe ? 'אני' : m.profiles.display_name}</label>
            </div>
        `;
    });
}

function showSettleForm() {
    let options = '<option value="">בחרי למי להעביר</option>';
    currentCarMembers.forEach(m => {
        if(m.profiles.id !== currentUser.id) {
            options += `<option value="${m.profiles.id}">${m.profiles.display_name}</option>`;
        }
    });
    document.getElementById('settle-paid-to').innerHTML = options;
    document.getElementById('settle-form-container').classList.remove('hidden');
}

function hideSettleForm() {
    document.getElementById('settle-form-container').classList.add('hidden');
    document.getElementById('settle-amount').value = '';
}

async function submitSettlement() {
    const paidTo = document.getElementById('settle-paid-to').value;
    const amount = parseFloat(document.getElementById('settle-amount').value);
    
    if(!paidTo || !amount || amount <= 0) return alert("נא לבחור שותפה ולהזין סכום תקין");
    
    const { error } = await supabaseClient.from('settlements').insert({
        group_id: currentCar.id,
        paid_by: currentUser.id,
        paid_to: paidTo,
        amount: amount
    });
    
    if(error) return alert("שגיאה בשמירת ההעברה: " + error.message);
    
    alert("העברת הכסף נשמרה בהצלחה!");
    hideSettleForm();
    loadDashboardData();
}

async function loadDashboardData() {
    if(!currentCar) return;

    // שליפה שטוחה ומאובטחת ללא קריסות של PostgREST Joins. שיוך השמות מבוצע מקומית במערך המשתמשים
    const { data: refuels } = await supabaseClient.from('refuels').select('*').eq('group_id', currentCar.id).order('created_at', { ascending: false });
    const { data: trips } = await supabaseClient.from('trips').select('*').eq('group_id', currentCar.id).order('created_at', { ascending: false });
    const { data: members } = await supabaseClient.from('group_members').select('profiles(id, display_name, email)').eq('group_id', currentCar.id);
    const { data: participants } = await supabaseClient.from('trip_participants').select('*');
    const { data: settlements } = await supabaseClient.from('settlements').select('*').eq('group_id', currentCar.id).order('created_at', { ascending: false });

    currentCarMembers = (members || []).filter(m => m && m.profiles);
    const safeRefuels = refuels || [];
    const safeTrips = trips || [];
    const safeParticipants = participants || [];
    const safeSettlements = settlements || [];

    const membersHTML = currentCarMembers.map(m => {
        const profile = m.profiles;
        if (profile.id === currentUser.id) {
            return `<div style="margin-bottom: 5px;"><strong style="color: var(--primary);">את/ה</strong> <span style="font-size: 0.85em; color: var(--text-light);">(${profile.display_name || 'ללא כינוי'})</span></div>`;
        } else {
            return `<div style="margin-bottom: 5px;"><strong>${profile.display_name || 'ללא כינוי'}</strong> <span style="font-size: 0.85em; color: var(--text-light); direction: ltr; display: inline-block;">(${profile.email})</span></div>`;
        }
    }).join('');
    document.getElementById('dash-members-list').innerHTML = membersHTML;

    // חישוב קילומטרז' ומד אוץ ברקע
    let lastRefuelOdo = safeRefuels.length > 0 ? Number(safeRefuels[0].odometer) : Number(currentCar.initial_odo);
    let tripsSinceRefuel = 0;
    const lastRefuelDate = safeRefuels.length > 0 ? new Date(safeRefuels[0].created_at) : new Date(0);
    
    safeTrips.forEach(t => {
        if(new Date(t.created_at) > lastRefuelDate) {
            tripsSinceRefuel += Number(t.distance);
        }
    });
    calculatedOdometer = lastRefuelOdo + tripsSinceRefuel;
    document.getElementById('dash-current-odo').innerText = calculatedOdometer.toFixed(0);

    let totalCost = 0, totalTripsKm = 0;
    let paymentsByUser = {}, kmByUser = {};

    currentCarMembers.forEach(m => {
        paymentsByUser[m.profiles.id] = { name: m.profiles.display_name, fuelPaid: 0, setPaid: 0, setReceived: 0 };
        kmByUser[m.profiles.id] = { name: m.profiles.display_name, km: 0 };
    });

    safeRefuels.forEach(r => {
        totalCost += Number(r.cost);
        if(paymentsByUser[r.paid_by]) paymentsByUser[r.paid_by].fuelPaid += Number(r.cost);
    });

    safeSettlements.forEach(s => {
        if(paymentsByUser[s.paid_by]) paymentsByUser[s.paid_by].setPaid += Number(s.amount);
        if(paymentsByUser[s.paid_to]) paymentsByUser[s.paid_to].setReceived += Number(s.amount);
    });

    safeTrips.forEach(t => {
        totalTripsKm += Number(t.distance);
        let tripParts = safeParticipants.filter(p => p.trip_id === t.id);
        if(tripParts.length > 0) {
            let splitDistance = Number(t.distance) / tripParts.length;
            tripParts.forEach(p => {
                if(kmByUser[p.user_id]) kmByUser[p.user_id].km += splitDistance;
            });
        } else {
            if(kmByUser[t.recorded_by]) kmByUser[t.recorded_by].km += Number(t.distance);
        }
    });

    let avgCostPerKm = totalTripsKm > 0 ? (totalCost / totalTripsKm) : 0;
    document.getElementById('dash-total-cost').innerText = `₪${totalCost.toFixed(0)}`;
    document.getElementById('dash-avg-cost').innerText = totalTripsKm > 0 ? `₪${avgCostPerKm.toFixed(2)}` : '0';
    document.getElementById('dash-total-km').innerText = totalTripsKm.toFixed(1);

    // יישור עמודות מימין לשמאל (RTL) - תאריך ושותפות תמיד בטור הימני ביותר (ראשון מימין)
    
    // 1. מצב קופה
    let balanceHTML = '<table><tr><th>שותפה</th><th>מצב כולל</th><th>שילמה דלק</th><th>נסעה (ק"מ)</th></tr>';
    currentCarMembers.forEach(m => {
        let id = m.profiles.id;
        let displayName = id === currentUser.id ? 'את/ה' : (m.profiles.display_name || 'אנונימית');
        let userKm = kmByUser[id] ? kmByUser[id].km : 0;
        let fuelPaid = paymentsByUser[id] ? paymentsByUser[id].fuelPaid : 0;
        let setPaid = paymentsByUser[id] ? paymentsByUser[id].setPaid : 0;
        let setReceived = paymentsByUser[id] ? paymentsByUser[id].setReceived : 0;
        
        let userOwesForFuel = userKm * avgCostPerKm;
        let finalBalance = fuelPaid - userOwesForFuel + setPaid - setReceived; 
        let color = finalBalance >= 0 ? 'var(--success)' : 'var(--danger)';
        
        balanceHTML += `<tr>
            <td>${displayName}</td>
            <td style="color: ${color}; font-weight:bold; direction:ltr; text-align:right;">${finalBalance > 0 ? '+' : ''}${finalBalance.toFixed(0)}₪</td>
            <td>₪${fuelPaid.toFixed(0)}</td>
            <td>${userKm.toFixed(1)}</td>
        </tr>`;
    });
    balanceHTML += '</table>';
    document.getElementById('dash-balances').innerHTML = totalTripsKm > 0 ? balanceHTML : '<p>אין מספיק נתונים לחשב.</p>';

    // 2. קיזוזים
    let setHTML = '<table><tr><th>תאריך</th><th>מעבירה</th><th>מקבלת</th><th>סכום</th></tr>';
    safeSettlements.slice(0, 5).forEach(s => {
        let byName = currentCarMembers.find(m => m.profiles.id === s.paid_by)?.profiles?.display_name || 'אנונימית';
        let toName = currentCarMembers.find(m => m.profiles.id === s.paid_to)?.profiles?.display_name || 'אנונימית';
        if(s.paid_by === currentUser.id) byName = 'את/ה';
        if(s.paid_to === currentUser.id) toName = 'את/ה';
        let date = new Date(s.created_at).toLocaleDateString('he-IL');
        setHTML += `<tr><td>${date}</td><td>${byName}</td><td>${toName}</td><td>₪${s.amount}</td></tr>`;
    });
    setHTML += '</table>';
    document.getElementById('dash-settlements-list').innerHTML = safeSettlements.length > 0 ? setHTML : '<p>אין העברות עדיין.</p>';

    // 3. תדלוקים
    let refuelsHTML = '<table><tr><th>תאריך</th><th>מתדלקת</th><th>עלות</th><th>ליטרים</th><th>מד אוץ</th></tr>';
    safeRefuels.slice(0, 5).forEach(r => {
        let date = new Date(r.created_at).toLocaleDateString('he-IL');
        let displayName = currentCarMembers.find(m => m.profiles.id === r.paid_by)?.profiles?.display_name || 'אנונימית';
        if (r.paid_by === currentUser.id) displayName = 'את/ה';
        refuelsHTML += `<tr><td>${date}</td><td>${displayName}</td><td>₪${r.cost}</td><td>${r.liters}</td><td>${r.odometer}</td></tr>`;
    });
    refuelsHTML += '</table>';
    document.getElementById('dash-refuels-list').innerHTML = safeRefuels.length > 0 ? refuelsHTML : '<p>אין תדלוקים.</p>';

    // 4. נסיעות
    let tripsHTML = '<table><tr><th>תאריך</th><th>נהגת</th><th>מרחק (ק"מ)</th><th>מד אוץ סופי</th><th>הערה</th></tr>';
    safeTrips.slice(0, 8).forEach(t => {
        let date = new Date(t.created_at).toLocaleDateString('he-IL', {day: '2-digit', month: '2-digit'});
        let displayName = t.recorded_by === currentUser.id ? 'את/ה' : (currentCarMembers.find(m => m.profiles.id === t.recorded_by)?.profiles?.display_name || 'אנונימית');
        let endOdoDisplay = t.end_odo ? Math.round(t.end_odo) : '-';
        let noteDisplay = t.note ? t.note : '-';
        tripsHTML += `<tr><td>${date}</td><td>${displayName}</td><td>${t.distance}</td><td>${endOdoDisplay}</td><td>${noteDisplay}</td></tr>`;
    });
    tripsHTML += '</table>';
    document.getElementById('dash-trips-list').innerHTML = safeTrips.length > 0 ? tripsHTML : '<p>אין נסיעות.</p>';
}

async function saveTrip() {
    const distanceInput = document.getElementById('trip-distance').value.trim();
    const endOdoInput = document.getElementById('trip-end-odo').value.trim();
    
    let distance = 0;
    let endOdo = null;
    
    // קביעת נתונים מקבילה ללא תיבת בחירה
    if (endOdoInput !== "") {
        endOdo = parseFloat(endOdoInput);
        if (endOdo < calculatedOdometer) {
            if(!confirm(`זהירות: מד האוץ שהזנת (${endOdo}) נמוך ממד האוץ המחושב הנוכחי (${calculatedOdometer.toFixed(0)}). להמשיך?`)) return;
        }
        distance = endOdo - calculatedOdometer;
        if (distance < 0) distance = 0;
    } else if (distanceInput !== "") {
        distance = parseFloat(distanceInput);
        if (distance <= 0) return alert("נא להזין מרחק תקין");
        endOdo = calculatedOdometer + distance;
    } else {
        return alert("אנא הזיני מרחק נסיעה או קריאת מד אוץ סופית");
    }

    if(distance > 200) {
        if(!confirm(`הוזנה נסיעה של מעל 200 ק"מ. לשמור?`)) return;
    }

    const note = document.getElementById('trip-note').value.trim();

    let selectedParticipants = [];
    currentCarMembers.forEach(m => {
        const checkbox = document.getElementById(`part-${m.profiles.id}`);
        if(checkbox && checkbox.checked) selectedParticipants.push(m.profiles.id);
    });

    if(selectedParticipants.length === 0) return alert("חייבת לבחור לפחות משתתפת אחת בנסיעה");

    // אבטחת טרנזקציות ומניעת קריסות שקטות בשמירה
    const { data: newTrip, error: tripError } = await supabaseClient.from('trips').insert({ 
        group_id: currentCar.id, 
        recorded_by: currentUser.id, 
        distance: distance,
        end_odo: endOdo,
        note: note
    }).select().single();

    if (tripError || !newTrip) return alert("שגיאה בשמירת הנסיעה: " + (tripError ? tripError.message : "נתונים לא חזרו"));
    
    const participantsData = selectedParticipants.map(userId => ({ trip_id: newTrip.id, user_id: userId }));
    const { error: partError } = await supabaseClient.from('trip_participants').insert(participantsData);

    if (partError) return alert("הנסיעה נשמרה אך נכשלה שמירת המשתתפים: " + partError.message);

    alert("הנסיעה נשמרה בהצלחה!");
    document.getElementById('trip-distance').value = '';
    document.getElementById('trip-end-odo').value = '';
    document.getElementById('trip-note').value = '';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
}

async function saveRefuel() {
    const cost = parseFloat(document.getElementById('refuel-cost').value);
    const liters = parseFloat(document.getElementById('refuel-liters').value);
    const odo = parseFloat(document.getElementById('refuel-odo').value);

    if (!cost || !liters || !odo) return alert("נא למלא את כל השדות");
    
    let gap = odo - calculatedOdometer;
    if(gap > 0.5) { 
        let addTrip = confirm(`שמנו לב שמד האוץ החדש שהזנת גבוה ב-${gap.toFixed(1)} ק"מ מהחישוב שלנו.\nהאם תרצי שנוסיף את הפער הזה אוטומטית כ"נסיעה לתחנה"?`);
        if(addTrip) {
            let selectedParticipants = [];
            currentCarMembers.forEach(m => {
                const cb = document.getElementById(`refuel-part-${m.profiles.id}`);
                if(cb && cb.checked) selectedParticipants.push(m.profiles.id);
            });
            if(selectedParticipants.length === 0) selectedParticipants.push(currentUser.id);

            const { data: newTrip } = await supabaseClient.from('trips').insert({ 
                group_id: currentCar.id, 
                recorded_by: currentUser.id, 
                distance: gap, 
                end_odo: odo, 
                note: "השלמה אוטומטית (נסיעה לתחנה)" 
            }).select().single();
            
            if(newTrip) {
                const participantsData = selectedParticipants.map(userId => ({ trip_id: newTrip.id, user_id: userId }));
                await supabaseClient.from('trip_participants').insert(participantsData);
            }
        }
    } else if(gap < -0.5) {
        if(!confirm(`זהירות: מד האוץ שהזנת (${odo}) נמוך מהמד המחושב שלנו (${calculatedOdometer.toFixed(0)}). להמשיך?`)) return;
    }

    const { error } = await supabaseClient.from('refuels').insert({ group_id: currentCar.id, paid_by: currentUser.id, cost: cost, liters: liters, odometer: odo });
    if (error) return alert("שגיאה בשמירת התדלוק: " + error.message);
    
    alert("התדלוק נשמר בהצלחה!");
    document.getElementById('refuel-cost').value = ''; document.getElementById('refuel-liters').value = ''; document.getElementById('refuel-odo').value = '';
    
    currentCarMembers.forEach(m => {
        const cb = document.getElementById(`refuel-part-${m.profiles.id}`);
        if(cb) cb.checked = (m.profiles.id === currentUser.id);
    });

    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
}

async function inviteUser() {
    const email = document.getElementById('invite-email').value.toLowerCase().trim();
    if (!email) return alert("נא להזין אימייל");
    const { error } = await supabaseClient.from('invitations').insert({ group_id: currentCar.id, invited_email: email, invited_by: currentUser.id });
    if (error) alert("שגיאה: " + error.message);
    else {
        alert(`הזמנה נשמרה.`);
        document.getElementById('invite-email').value = '';
        document.getElementById('whatsapp-share-container').classList.remove('hidden');
    }
}

function shareWhatsApp() {
    const text = encodeURIComponent(`היי! הוספתי אותך לרכב "${currentCar.name}" באפליקציית הדלק 🚗\nכנסי ללינק ותתחברי עם הג'ימייל:\n${window.location.origin}`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
}

// ניהול אירועי הזדהות מאובטח למניעת אתחול כפול שגורם לחזרה למסך הבית
supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
        if (!currentUser || currentUser.id !== session.user.id) {
            initializeApp(session.user);
        }
    } else {
        currentUser = null;
        currentCar = null;
        showScreen('login-screen');
    }
});
